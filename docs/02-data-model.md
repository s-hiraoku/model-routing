# 02. データモデル

SQLite(`bun:sqlite`)+ Drizzle ORM。DDL 相当を SQL で示す(実装は Drizzle スキーマ + `drizzle-kit`)。

## ER 概観

```
sessions ──1:N── requests(全 API リクエスト。本番もリプレイも同じテーブル)
   │                │
   │                └──0:1── shift_events(変速判断の記録)
   │
   └──1:N── task_events(hooks からのタスク境界通知)
                │
                └──0:1── eval_tasks(評価対象に選ばれたタスク)
                            │
                            └──1:N── replay_runs(variant ごとの再実行)
                                        │           └─(requests に紐づく: run_id 列)
                                        └──1:N── judgments
                                        └──0:N── human_reviews

tier_profiles(集計結果。カテゴリ × variant)
quota_events(枠消費・429 の記録)

── フィードバックループ関連(07 参照)──
preference_queue(A/B 選好質問のキュー・配信状態)
feedback_notes(自由記述フィードバックと LLM 解釈・処理状態)
policy_changelog(ポリシー全変更の履歴・根拠・通知状態)
```

## DDL

```sql
-- ─────────────────────────────────────────────
-- セッション: Claude Code の 1 会話
-- ─────────────────────────────────────────────
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,          -- Claude Code の session_id(hooks 由来)
  cwd           TEXT,
  git_remote    TEXT,
  first_seen_at INTEGER NOT NULL,          -- unixtime ms
  last_seen_at  INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────────
-- タスクイベント: hooks(UserPromptSubmit)からの通知
-- 「ユーザーが 1 つの指示を投げた瞬間」= タスク境界 = 変速判断の起点
-- ─────────────────────────────────────────────
CREATE TABLE task_events (
  id            TEXT PRIMARY KEY,          -- UUIDv7
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  created_at    INTEGER NOT NULL,
  cwd           TEXT NOT NULL,
  git_head      TEXT,                      -- worktree 再現の基点
  git_dirty     INTEGER NOT NULL,
  prompt_text   TEXT NOT NULL,
  prompt_hash   TEXT NOT NULL,
  -- 分類(ヒューリスティックは即時、LLM 分類は evals が後から上書き)
  task_category TEXT,
  category_source TEXT,                    -- heuristic | llm | manual
  category_confidence REAL,
  self_contained  INTEGER                  -- 1/0/NULL=未判定
);
CREATE INDEX idx_task_events_created ON task_events(created_at);
CREATE INDEX idx_task_events_category ON task_events(task_category, created_at);

-- ─────────────────────────────────────────────
-- リクエストログ: gateway を通った全リクエスト(本番 + リプレイ共通)
-- ─────────────────────────────────────────────
CREATE TABLE requests (
  id               TEXT PRIMARY KEY,       -- UUIDv7
  session_id       TEXT REFERENCES sessions(id),
  replay_run_id    TEXT,                   -- NULL = 本番 / 非NULL = リプレイ由来
  created_at       INTEGER NOT NULL,
  model_requested  TEXT NOT NULL,          -- Claude Code / SDK が指定したモデル
  model_served     TEXT NOT NULL,          -- 変速後に実際へ送ったモデル
  -- 特徴量(ボディを開かず統計・変速判断の事後分析ができるように)
  is_streaming     INTEGER NOT NULL,
  message_count    INTEGER NOT NULL,
  tool_count       INTEGER NOT NULL,
  has_tool_results INTEGER NOT NULL,
  has_images       INTEGER NOT NULL,
  system_hash      TEXT,
  prompt_hash      TEXT NOT NULL,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cache_read_tokens  INTEGER,              -- キャッシュ分断の計測に必須
  cache_write_tokens INTEGER,
  -- 結果
  status           TEXT NOT NULL,          -- ok | provider_error | gateway_error
                                           -- | client_abort | rate_limited
  http_status      INTEGER,
  stop_reason      TEXT,
  latency_ms       INTEGER,
  ttft_ms          INTEGER,
  error_message    TEXT,
  body_path        TEXT NOT NULL           -- data/bodies/{yyyy-mm}/{id}.json.zst
);
CREATE INDEX idx_requests_created ON requests(created_at);
CREATE INDEX idx_requests_session ON requests(session_id, created_at);
CREATE INDEX idx_requests_replay ON requests(replay_run_id);

-- ─────────────────────────────────────────────
-- 変速イベント: shifter が介入した(または介入を見送った理由が興味深い)リクエスト
-- 素通し(never_touch や非 routing モード)は記録しない
-- ─────────────────────────────────────────────
CREATE TABLE shift_events (
  request_id      TEXT PRIMARY KEY REFERENCES requests(id),
  created_at      INTEGER NOT NULL,
  policy_version  TEXT NOT NULL,
  task_event_id   TEXT REFERENCES task_events(id),  -- どのタスク文脈での判断か
  decided_category TEXT,
  gear_from       TEXT NOT NULL,           -- tier: high|mid|low(model_requested の正規化)
  gear_to         TEXT NOT NULL,           -- 変速後 tier(同値なら「昇格見送り」等の記録)
  reason          TEXT NOT NULL            -- demote_agent_step | promote_task | hold_sticky
                                           -- | quota_governor | degrade_guard | manual
);

-- ─────────────────────────────────────────────
-- 評価タスク: task_events から選抜された再実行対象
-- ─────────────────────────────────────────────
CREATE TABLE eval_tasks (
  id             TEXT PRIMARY KEY,
  task_event_id  TEXT NOT NULL REFERENCES task_events(id),
  batch_id       TEXT NOT NULL,            -- 例: 2026-W28
  created_at     INTEGER NOT NULL,
  task_category  TEXT NOT NULL,
  repo_path      TEXT NOT NULL,
  base_commit    TEXT NOT NULL,
  prompt_text    TEXT NOT NULL,
  verify_command TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 -- pending | running | ran | judged | reviewed | excluded
);
CREATE INDEX idx_eval_tasks_batch ON eval_tasks(batch_id, status);

-- ─────────────────────────────────────────────
-- リプレイ実行: eval_task × variant の再実行 1 回 = 1 行
-- variant: 'high' | 'mid' | 'low' | 'mid+demote'
-- ─────────────────────────────────────────────
CREATE TABLE replay_runs (
  id            TEXT PRIMARY KEY,
  eval_task_id  TEXT NOT NULL REFERENCES eval_tasks(id),
  variant       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  status        TEXT NOT NULL,             -- ok | error | timeout | rate_limited
  duration_ms   INTEGER,
  turns         INTEGER,                   -- Agent SDK から取得
  total_input_tokens  INTEGER,             -- requests(replay_run_id)の合計。枠消費の実測
  total_output_tokens INTEGER,
  total_cache_read    INTEGER,
  diff_path     TEXT,                      -- data/runs/{id}/changes.patch
  diff_stat     TEXT,
  final_message_path TEXT,
  verify_passed INTEGER,                   -- NULL = 未実施
  error_message TEXT,
  UNIQUE(eval_task_id, variant)
);

-- ─────────────────────────────────────────────
-- ジャッジ判定: baseline(mid) vs 各 variant、position 別 1 判定 1 行
-- ─────────────────────────────────────────────
CREATE TABLE judgments (
  id             TEXT PRIMARY KEY,
  eval_task_id   TEXT NOT NULL REFERENCES eval_tasks(id),
  candidate_run_id TEXT NOT NULL REFERENCES replay_runs(id),
  baseline_run_id  TEXT NOT NULL REFERENCES replay_runs(id),
  position       TEXT NOT NULL,            -- 'candidate_first' | 'baseline_first'
  prompt_version TEXT NOT NULL,            -- 'pairwise-v1'
  created_at     INTEGER NOT NULL,
  verdict        TEXT NOT NULL,            -- candidate_win | baseline_win | tie
  scores_json    TEXT,                     -- 診断用絶対評価
  rationale      TEXT,
  UNIQUE(eval_task_id, candidate_run_id, position)
);

-- ─────────────────────────────────────────────
-- 人間レビュー
-- ─────────────────────────────────────────────
CREATE TABLE human_reviews (
  id            TEXT PRIMARY KEY,
  eval_task_id  TEXT NOT NULL REFERENCES eval_tasks(id),
  candidate_run_id TEXT NOT NULL REFERENCES replay_runs(id),
  baseline_run_id  TEXT NOT NULL REFERENCES replay_runs(id),
  created_at    INTEGER NOT NULL,
  source        TEXT NOT NULL DEFAULT 'review_session',
                                            -- review_session(UI で自発的に)
                                            -- | push(A/B 選好質問への回答)
  verdict       TEXT NOT NULL,             -- candidate_win | baseline_win | tie | skip
  note          TEXT,
  review_seconds INTEGER
);
-- 集計時、human_reviews がある ペアは judge 判定を破棄して人間判定を採用する(07 参照)

-- ─────────────────────────────────────────────
-- A/B 選好質問キュー: 通知する質問の選定・配信・回答状態
-- ─────────────────────────────────────────────
CREATE TABLE preference_queue (
  id               TEXT PRIMARY KEY,
  eval_task_id     TEXT NOT NULL REFERENCES eval_tasks(id),
  candidate_run_id TEXT NOT NULL REFERENCES replay_runs(id),
  baseline_run_id  TEXT NOT NULL REFERENCES replay_runs(id),
  priority         REAL NOT NULL,          -- 影響度 × 不確実性(07 の選定式)
  queued_at        INTEGER NOT NULL,
  notified_at      INTEGER,
  answered_at      INTEGER,                -- 回答は human_reviews(source='push') に入る
  expires_at       INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   -- pending | notified | answered | expired | cancelled
);
CREATE INDEX idx_pref_queue_status ON preference_queue(status, priority);

-- ─────────────────────────────────────────────
-- 自由記述フィードバック(/model-feedback、満足度チェック経由)
-- ─────────────────────────────────────────────
CREATE TABLE feedback_notes (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  source      TEXT NOT NULL,               -- skill | cli | satisfaction_check
  text        TEXT NOT NULL,
  parsed_json TEXT,                        -- LLM 解釈: {intent, target_category, proposal}
  status      TEXT NOT NULL DEFAULT 'pending'
              -- pending(未処理)| proposed(変更案を提示中)
              -- | incorporated(反映済み)| declined(却下・記録のみ)
  ,resolution TEXT                         -- 反映内容 or 却下理由(changelog への参照込み)
);

-- ─────────────────────────────────────────────
-- ポリシー変更履歴: 自動・人間問わず全変更を記録(自己進化の監査ログ)
-- ─────────────────────────────────────────────
CREATE TABLE policy_changelog (
  id             TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  change_json    TEXT NOT NULL,            -- 変更の diff(ルール単位)
  origin         TEXT NOT NULL,            -- auto_evidence(評価バッチの証拠)
                                           -- | human_feedback(feedback_notes 由来)
                                           -- | auto_rollback(劣化検知サスペンド)
                                           -- | manual(overrides 直接編集)
  evidence       TEXT,                     -- win_rate/n/κ or feedback_note_id
  notified_at    INTEGER                   -- changelog 通知の送信時刻
);
CREATE INDEX idx_changelog_version ON policy_changelog(policy_version);

-- ─────────────────────────────────────────────
-- tier プロファイル: 集計結果(カテゴリ × variant)
-- ─────────────────────────────────────────────
CREATE TABLE tier_profiles (
  batch_id       TEXT NOT NULL,
  variant        TEXT NOT NULL,
  task_category  TEXT NOT NULL,
  n              INTEGER NOT NULL,
  win_rate       REAL NOT NULL,            -- vs baseline(tie = 0.5)
  wilson_low     REAL NOT NULL,
  wilson_high    REAL NOT NULL,
  verify_pass_rate REAL,
  avg_turns        REAL,                   -- 「安いモデルはターンが伸びる」検出用
  avg_total_tokens REAL,                   -- 実枠消費(ターン増を含む正味)
  avg_duration_ms  REAL,
  error_rate     REAL NOT NULL,
  judge_human_kappa REAL,
  PRIMARY KEY (batch_id, variant, task_category)
);

-- ─────────────────────────────────────────────
-- 枠イベント
-- ─────────────────────────────────────────────
CREATE TABLE quota_events (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  kind         TEXT NOT NULL,              -- replay_run | judge_run | rate_limited
  ref_id       TEXT
);
CREATE INDEX idx_quota_window ON quota_events(created_at);
```

## タスクカテゴリ・タクソノミー(v1)

`shared` に enum として定義。**v1 は 7 + unknown に固定**。変速方向の当たりを付ける観点でグルーピングしてある(実際の変速判断は評価結果 = shift-policy.yaml に従う):

| カテゴリ | 定義 | 変速の仮説 |
|---|---|---|
| `plan` | 設計・計画・アーキテクチャ検討 | **昇格候補**(Opus の価値が出やすい) |
| `debug` | バグ調査・原因特定・修正 | **昇格候補** |
| `code_gen` | 新規コード・機能の実装 | 中立(Sonnet 維持) |
| `code_edit` | 既存コードの修正・リファクタ | 中立 |
| `review` | コードレビュー・指摘 | 昇格候補(好み次第) |
| `test` | テスト作成・修正 | **降格候補**(定型度が高い) |
| `docs` | ドキュメント・コミットメッセージ等 | **降格候補** |
| `unknown` | 分類不能 | 触らない |

これとは別に、カテゴリ横断の**ターン種別**として `agent_step`(直前が tool_result で、次のツール呼び出しを決めるだけの中間ターン)を shifter のヒューリスティックで判定する。これがターン単位降格の主対象([05](05-routing-engine.md))。

## 自己完結性フィルタ(self_contained)

リプレイ再現性のため、評価対象は以下を満たすタスクに限る(LLM 分類時に同時判定):

- 指示文と repo の中身だけで作業内容が決まる(直前の会話文脈に依存しない)
- 外部サービスの状態に依存しない
- 破壊的・副作用のある操作を含まない(push / deploy 等)

## ボディ・成果物ファイル仕様

```
data/bodies/2026-07/{request_id}.json.zst   # {"request":..., "response":...}(SSE は結合再構成)
data/runs/{replay_run_id}/
  ├── changes.patch
  ├── final.md
  └── transcript.json                        # Agent SDK のメッセージ列
```

- 保存ヘッダは許可リスト(`user-agent`, `anthropic-version`, `anthropic-beta`)のみ。認証系は保存前に必ず落とす。

## データ保持ポリシー

| データ | 保持 | 削除 |
|---|---|---|
| requests / task_events / shift_events(メタ) | 無期限 | — |
| ボディファイル | 90 日(eval_tasks 紐づきは無期限) | `scripts/prune.ts`(月次) |
| runs 成果物 / judgments | 無期限(評価履歴が資産) | — |
| worktree 本体 | 実行後即削除 | replayer が後始末 |

## 個人情報・機密

- `data/` は gitignore。ローカルから出さない。
- 送信先は Anthropic のみ(元々 Claude Code が送っている範囲と同一)。マルチプロバイダー時代にあった「別プロバイダーへのコード送信」の懸念は**スコープ縮小により消滅**。`exclude_repos` は評価ノイズ除外用として残す。
