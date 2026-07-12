# 04. 評価パイプライン

変速ルールの根拠を作る。問いは 2 つだけ:

1. **どのカテゴリのタスクなら Haiku(low)に降ろしても壊れないか?**(降格の安全性)
2. **どのカテゴリのタスクは Opus(high)に上げる価値があるか?**(昇格の価値)

実開発ログからタスクをサンプリングし、git worktree で隔離した同一 repo 状態の上で、**tier 別 variant(high / mid / low / mid+demote)で同じタスクを再実行**して成果を比較する。再実行は Claude Agent SDK を gateway 経由で走らせるので、`mid+demote` は本番と同一の変速コードパスの検証になる。

## パイプライン全体

```
bun run evals -- run --batch 2026-W28 --stage all
  │
  ├─ stage 1: classify   未分類 task_events にカテゴリ + 自己完結性を付与
  ├─ stage 2: sample     層化サンプリングで eval_tasks を作成(枠見積もり付き)
  ├─ stage 3: replay     各 eval_task を worktree 上で 4 variant 実行
  ├─ stage 4: judge      baseline(mid) vs 各 variant をペアワイズ判定
  ├─ stage 5: aggregate  win rate + Wilson CI → tier_profiles 更新
  ├─ stage 6: report     Markdown レポート + shift-policy.yaml 生成 + changelog 通知
  └─ stage 7: feedback   A/B 選好キュー生成 + 自由記述フィードバックの取り込み(07 参照)
```

各 stage は冪等(status カラムで進捗管理、再実行で続きから)。stage 3/4 は `schedule.allowed_hours` 内のみ実行し、429 検出で中断 → 次ウィンドウ再開。

これとは別に**夜間ジョブ**(`bun run evals -- nightly`)がログ監視(暗黙シグナル・新モデル検知・劣化判定)を毎夜実行する。仕様は [07-feedback-and-evolution.md](07-feedback-and-evolution.md#自動ループ-3-つのトリガー)。

## Stage 1: タスク分類(classifier)

対象は `task_events`。2 段構え。

### 1 段目: ヒューリスティック(gateway 受信時に即時実行済み)

`shared/classifyHeuristic(promptText)`。正規表現の優先順位ルール:

```
/レビュー|review/                                → review
/テスト.*(書|作|追加)|test/                       → test
/(エラー|error|落ち|動かない|直らない|stack ?trace)/ → debug
/(設計|方針|アーキテクチャ|どうすべき|計画|plan)/     → plan
/(README|ドキュメント|コメント|コミットメッセージ)/    → docs
/(リファクタ|直して|修正|変更|リネーム|移動)/          → code_edit
/(実装|作って|追加して|新規)/                        → code_gen
マッチなし → unknown, confidence 0
```

### 2 段目: LLM 分類(オフライン、evals のみ)

unknown / confidence < 0.8 を **Agent SDK(low tier、ツール無効、gateway 経由)**でバッチ分類。自己完結性([02](02-data-model.md#自己完結性フィルタself_contained))も同時判定。

- 入力: `prompt_text`(先頭 4,000 字)+ プロジェクト名
- 出力(JSON 強制): `{"category":"...", "confidence":0-1, "self_contained":bool, "reason":"..."}`
- confidence < 0.6 → `unknown` のまま(評価から除外)
- プロンプト: `config/prompts/classify-v1.md`(変更時は v2 追加でバージョン追跡)

### M1 ゲート

`bun run evals -- audit-classify --n 50` → ランダム 50 件を CLI 表示、y/n で人間判定。納得率 < 80% なら先へ進まない。

## Stage 2: サンプリング(sampler)

### 選択条件

```
対象: 直近 dedup_window_days 日の task_events のうち
  - task_category NOT IN ('unknown')
  - self_contained = 1
  - git_head IS NOT NULL かつ git_dirty = 0    ← worktree 再現性
  - repo_path が exclude_repos に含まれない
  - prompt_hash が過去バッチと重複しない
  - 同一 session からは最大 2 件

層化: カテゴリごとに max(per_category_min, per_batch × 実トラフィック比率)
優先: 変速仮説に直結するカテゴリ(plan / debug / test / docs)を優先配分
```

> `git_dirty = 0` でどれだけ母数が減るかは M1 で実測。減りすぎるなら「dirty でも HEAD から再現し、ジャッジに前提差分を伝える」緩和を検討(v2)。

### 枠見積もり(実行前ガード)

```
実行数 = タスク数 × 4 variant(replay)+ タスク数 × 3 比較 × 2 position(judge)
```

`eval_runs_per_window` から必要ウィンドウ数を算出して表示、`--yes` なしでは確認を取る。収まらないバッチは複数夜に自動分割(中断・再開機構で対応)。

## Stage 3: リプレイ(replayer)

### variant 定義(eval.yaml)

| variant | 実行内容 | 目的 |
|---|---|---|
| `high` | 全ターン Opus | 昇格の価値測定 |
| `mid` | 全ターン Sonnet | **baseline** |
| `low` | 全ターン Haiku | 降格の限界測定 |
| `mid+demote` | Sonnet 起点 + gateway の agent_step 降格ルール適用 | **本番想定の実機検証** |

### 実行経路

```
replayer
 ├─ run 固有の gateway を createGatewayApp でエフェメラルポートに起動
 └─ Agent SDK query({ prompt, model: variantのtier, cwd: worktree,
                      permissionMode: acceptEdits, allowedTools: 編集+Bash等に限定,
                      env: { ANTHROPIC_BASE_URL: run固有gateway } })
      └─ gateway が固定 replay context を見てポリシー適用(mid+demote のみ書き換え発生)
```

- Agent SDK の権限・ツール設定は「worktree 内の編集 + Bash は自動承認、worktree 外への書き込み禁止」を構成(**具体的なオプション名は実装時に Agent SDK 最新ドキュメントで確認**)
- 専用 gateway は `{ run_id, variant }` を起動時に固定し、本番 gateway の状態やログを共有しない。`X-MR-Variant` が入力にあっても上流へは転送しない
- タイムアウトで SIGTERM → 5 秒後 SIGKILL。429 は `rate_limited` で記録しバッチ中断
- **baseline も毎回再実行**(過去成果物の使い回しはしない。条件を揃える)

### worktree ライフサイクル

```
1. git -C {repo} worktree add {tmp}/wt-{run_id} {base_commit}
2. setup_command があれば実行(依存インストール)
3. Agent SDK 実行
4. 成果物回収: git add -A -N && git diff → changes.patch / final.md / transcript.json
   verify_command があれば実行 → verify_passed
5. git worktree remove --force(必ず finally で)
```

実行は直列(concurrency 1)。並列化は枠・負荷を見て M5 で検討。

## Stage 4: LLM-as-Judge(judge)

### 方式: baseline(mid)固定のペアワイズ比較

- 比較は `high vs mid` / `low vs mid` / `mid+demote vs mid` の 3 ペア × position 2(A/B 入替)
- position 2 判定が食い違えば `tie`(位置バイアス対策)
- judge は **Opus(Agent SDK、ツール無効、gateway 経由)** の 1 系統。Claude 同士の比較なので自己選好バイアスの影響は相対的に小さい。その分**人間抜き取りを 25% に厚くして**信頼性を担保する
- judge 出力の JSON が壊れていたらリトライ 1 回 → 失敗は判定除外で記録

### ジャッジ入力の構成

```
- タスク指示(prompt_text 全文)
- repo コンテキスト: 変更対象ファイルの変更前内容(diff に登場するファイルのみ、計 30,000 字まで)
- 成果物 A / B: changes.patch + final.md + verify 結果
```

### ジャッジプロンプト(config/prompts/pairwise-v1.md)

```markdown
あなたはシニアソフトウェアエンジニアとして、同一タスクに対する
2 つのコーディングエージェントの成果物を比較評価する。

# タスク指示
{task_prompt}

# 変更前の関連ファイル
{before_context}

# 成果物 A
## 変更差分
{diff_a}
## エージェントの最終報告
{final_a}
## 自動テスト: {verify_a}

# 成果物 B
(同構成)

# 評価基準(重要度順)
1. 正しさ: 変更はタスクを正しく達成しているか。バグ・見落としがないか
2. 指示遵守: 指示の範囲を守っているか(頼んでいない変更・過剰な作業は減点)
3. コード品質: 既存コードの流儀に合っているか。無駄な複雑さがないか
4. 効率: 同水準なら差分が小さく報告が簡潔な方を上とする

# 注意
- 最終報告の自信満々な文体に惑わされず、差分そのものを読むこと
- 自動テスト結果がある場合は最優先の証拠として扱うこと
- どちらも同水準なら遠慮なく tie とすること

# 出力(JSON のみ)
{"verdict": "A" | "B" | "tie",
 "scores": {"A": {"correctness":1-5, "instruction_following":1-5, "code_quality":1-5, "efficiency":1-5},
            "B": {...}},
 "rationale": "150 字以内で判定理由"}
```

## Stage 5: 人間の検証と選好(Review UI)

人間の判定は 2 経路で入る。どちらも `human_reviews` に記録され、**人間判定があるペアは集計時にジャッジ判定を破棄して人間判定を採用**する。

- **プッシュ(A/B 選好質問)**: stage 7 が「人間の一票が最も価値を持つペア」を優先度付きで週 3 問まで通知([07](07-feedback-and-evolution.md#1-ab-選好質問プッシュ型チャットのどちらの回答がいいですかに相当))
- **プル(レビューセッション)**: review-ui のキューを見たいときに消化

### プル側のキュー選定

1. position 入替で判定が割れたペア → **全件**
2. それ以外から 25% ランダム抽出

### UI 仕様(packages/review-ui)

localhost:8585、Hono JSX SSR + フォーム POST。

- キュー画面: 未レビュー件数、カテゴリ別内訳
- 比較画面: タスク指示 + 左右 2 ペイン(diff ハイライト付き)。**variant 名とジャッジ判定は伏せる**。`A` / `B` / `同等` / `スキップ`(キー a/b/t/s)。プッシュ通知のリンク先はこの画面の 1 件版(クイック比較)
- 判定後に正体・ジャッジ判定・rationale を開示 → 次へ
- 所要時間を自動記録
- 提案ページ: フィードバック由来のポリシー変更案の承認/却下([07](07-feedback-and-evolution.md#2-自由記述フィードバックプル型いつでも))
- 満足度ページ: 月 1 問チェックの回答先

M2 の最小 Review UI は `bun run review-ui` で起動し、`/queue` で未レビュー judgment ペア、`/compare/:evalTaskId/:candidateRunId/:baselineRunId` でブラインド比較、`POST /reviews` で `human_reviews` 保存、`/reveal/...` で variant と judge summary を開示する。キュー取得はレビュー済みペアを除外し、詳細取得は保存直後の reveal のためレビュー済みも参照できる。

### κ の算出とゲート

human_reviews とジャッジ最終判定で Cohen's κ(win/loss/tie の 3 値)。

- **κ ≥ 0.6**: プロファイルを信頼して変速ポリシーに使ってよい
- **0.4 ≤ κ < 0.6**: 参考値。降格ルールのみ(保守的側)に限定使用
- **κ < 0.4**: ポリシー生成から除外。プロンプト・カテゴリ定義を見直す

## Stage 6: 集計(aggregator)とレポート

### 集計(カテゴリ × variant)

```
判定値: candidate_win = 1, tie = 0.5, baseline_win = 0(position 2 判定を 1 タスク 1 値に集約)
       ※ human_reviews があるペアは人間判定で置き換え(judge 判定は κ 計測のみに使用)
win_rate / wilson_low / wilson_high(Wilson 95%)
verify_pass_rate(客観指標。別掲)
avg_turns / avg_total_tokens   ← 重要: low が「勝率同等だがターン数 1.5 倍」なら
                                   実枠消費で負けている可能性がある(降格の正味効果を判定)
error_rate
```

### レポート(data/reports/2026-W28.md)

- カテゴリ × variant の win_rate 表(CI・n・verify・avg_turns・avg_total_tokens 付き)
- human-judge κ(カテゴリ別)
- **降格判定表**: 「low / mid+demote が品質を落とさず(wilson_low > 0.40)、正味トークンでも得か」
- **昇格判定表**: 「high が明確に勝つ(wilson_low > 0.55)カテゴリはどれか」
- 枠消費実績、有意差未達カテゴリの必要追加サンプル数
- shift-policy.yaml の生成([05](05-routing-engine.md#ポリシー生成ルール))

## CLI まとめ

```bash
bun run evals -- run --batch 2026-W28 --stage all --yes
bun run evals -- run --batch 2026-W28 --stage classify --llm
bun run evals -- run --batch 2026-W28 --stage replay --gateway=http://localhost:8484
bun run evals -- run --batch 2026-W28 --stage judge   # 特定 stage のみ
bun run evals -- run --batch 2026-W28 --stage aggregate
bun run evals -- run --batch 2026-W28 --stage report --existing-policy config/shift-policy.yaml
bun run evals -- run --batch 2026-W28 --stage feedback
bun run evals -- drift --from 2026-W28 --to 2026-W29
bun run evals -- model-handoff --batch 2026-W30 --from 2026-W29
bun run evals -- nightly
bun run evals -- audit-classify --n 50
bun run evals -- estimate --batch 2026-W28            # 枠見積もりのみ
bun run evals -- report                               # M1 母数レポート
bun run smoke                                         # Agent SDK 疎通(バッチ前必須)
bun run review-ui
```

M1 時点では `classify` はデフォルトでヒューリスティックのみ実行する。`--llm` を付けると unknown / confidence < 0.8 の task_events を Claude Agent SDK(low tier、ツール無効)へ送る。`sample` は `--yes` なしでは dry run として枠見積もりだけを表示する。

M2 の `replay` は `eval_tasks` ごとに configured variant の `replay_runs` を作成し、既存 run はスキップする。実行成果物は `data/runs/{replay_run_id}/` に保存する。各 run は固定 `run_id` / `variant` を持つ専用 gateway をエフェメラルポートで起動し、完了時に停止する。`mid+demote` は mid tier モデルで実行し、専用 gateway が passthrough モードのまま agent step だけ low tier へ書き換え、`requests.replay_run_id` と `shift_events` に記録する。

M2 の `judge` は `replay_runs.status = 'ok'` の baseline(mid) と各 non-baseline run を比較し、`judgments` に `candidate_win` / `baseline_win` / `tie` を保存する。`judge.position_swap = true` の場合は candidate-first / baseline-first の 2 件を作り、既存 judgment は `(eval_task_id, candidate_run_id, position)` でスキップする。ジャッジには Agent SDK の `outputFormat: json_schema`、`tools: []`、`maxTurns: 1` を使い、JSON パース失敗時は 1 回リトライする。

M3 の `aggregate` は position swap の judge 不一致を `tie` とし、同じペアに `human_reviews` がある場合は最新の人間判定を採用して `tier_profiles` を upsert する。`report` は `tier_profiles` から Markdown レポート、policy changelog JSON、shift-policy 候補を生成する。policy 生成は `eval.yaml` の `policy_generation` 閾値と κ を満たすものだけを採用し、`--existing-policy` の `overrides` を保持する。

M5 の `nightly` は既存ログから訂正マーカー、未知モデル、shift 後エラーを集計し、日次 Markdown を `data/reports/` に書き出す。`--policy` 指定時は shift 後エラーが閾値以上のカテゴリを `overrides.action: none` に suspend し、auto rollback changelog を出力する。`feedback` stage は `feedback.yaml` の週次注意予算を見て、未レビューの blind A/B pair を `preference_queue` に冪等 enqueue する。push 回答は Review UI の `/push` から `human_reviews(source='push')` に接続済み。

M5 の `drift` は 2 つの batch の `tier_profiles` を比較し、Wilson CI が分離したカテゴリ × variant、または `--min-delta` 以上 win_rate が動いたものを Markdown で表示する。次バッチで評価観点や policy 閾値を見直すための警告であり、単独では policy を変更しない。

M5 の `model-handoff` は `models.yaml` 差し替え後の tier 定義と `eval.yaml` の variants から、次バッチで実行する classify/sample/replay/judge/aggregate/report/feedback/drift コマンドと枠見積もりを Markdown で出す。実際の再評価・policy 再生成は既存 stage を順に実行する。
