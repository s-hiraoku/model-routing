# 06. 実装計画(マイルストーン別タスク分解)

各マイルストーンは「動くものが増える」単位。**最初の 1 日で成立条件を検証し、M0〜M2 で想定外を出し切る**方針。

## M0: スパイク → 透過プロキシ + ログ記録 + hooks

**ゴール**: OAuth model 書き換えの可否判定。Claude Code を gateway 経由にして 1 週間支障ゼロ。タスク境界が repo 状態付きで記録される。

### Day 1: 成立条件スパイク(最優先)

- [ ] `scripts/spike-rewrite.ts`: 数十行のミニプロキシで model 書き換え検証
  - [ ] sonnet → haiku(降格)が通るか
  - [ ] sonnet → opus(昇格)が通るか
  - [ ] streaming でも通るか / Claude Code の表示・後続ターンが壊れないか
- [ ] 結果を `docs/decisions.md` に記録し、進路決定:
  - 全面成立 → 本計画どおり
  - 降格のみ成立 → promote 系を設計から外して継続
  - 不成立 → Plan B(ログ・可視化ツール)へ転換

### 本体

- [ ] モノレポ初期化(Bun workspaces、tsconfig.base、Biome、`bun test`)
- [ ] `shared`: Tier / TaskCategory / RequestFeatures / TaskEvent 型、config ローダー(Zod)、UUIDv7、ハッシュ、`classifyHeuristic`
- [ ] `datastore`: Drizzle スキーマ(sessions / requests / task_events / quota_events 先行)、マイグレーション、WAL
- [ ] `gateway`:
  - [ ] Bun.serve + Hono、`/internal/healthz`、全パス透過プロキシ(OAuth ヘッダ無加工)
  - [ ] `POST /v1/messages`: Zod パース → 特徴量抽出 → 転送 → tee してログ
  - [ ] SSE 逐次 flush 中継 + イベント結合による Message 再構成
  - [ ] client_abort / 上流エラー / 429 のハンドリングと記録
  - [ ] ボディ zstd 保存(許可リストヘッダのみ)
  - [ ] `POST /internal/task-event`(ヒューリスティック分類の即時実行込み)/ `GET /internal/stats`
- [ ] `hooks/notify-task.ts`(git HEAD/dirty 取得、fire-and-forget)+ settings.json 登録手順 README
- [ ] `scripts/db-init.ts` / `scripts/prune.ts` / `scripts/log-explorer.ts`(最低限の検索・表示)
- [ ] テスト: SSE 再構成ユニット、モック上流(`UPSTREAM` 差し替え)E2E
- [ ] **運用開始**: `ANTHROPIC_BASE_URL` 切り替え、1 週間運用

**ゲート**: スパイク結論が出ている。エラー率 0%(client_abort 除く)、体感遅延なし、task_events に git_head 付き記録、stats のキャッシュヒット率・トークン集計が妥当(M4 の基準線)。

**想定外が出やすい所**: SSE の flush 漏れ(体感が壊れる)、hooks の入力フィールド仕様、OAuth トラフィックの未知ヘッダ・未知エンドポイント。

## M1: 分類 + サンプラー + ログ探索

**ゴール**: task_events にカテゴリと自己完結性が付き、評価対象を選べる。サンプル母数の実測。

- [ ] `evals`: stage runner 骨格(冪等、status 遷移、`--stage`、allowed_hours 制御)
- [ ] Agent SDK の疎通ラッパー(`bun run smoke`: gateway 経由で 1 タスク実行できること)
- [ ] stage 1 classify: LLM バッチ分類 + 自己完結性判定(`classify-v1.md`、low tier・ツール無効)
- [ ] stage 2 sample: 層化サンプリング、dedup、dirty フィルタ、枠見積もり、`--yes` 確認
- [ ] `audit-classify` CLI(50 件目視)
- [ ] `datastore`: eval_tasks 追加
- [ ] カテゴリ分布・dirty 率・自己完結率レポート

**ゲート**: 納得率 ≥ 80%、unknown < 15%、`git_dirty=0 && self_contained` の母数が週 20 タスク以上(不足なら dirty 緩和を前倒し検討)。

**想定外が出やすい所**: カテゴリ境界の曖昧さ(code_edit / debug の混線)、dirty 率が高くて母数が枯れる。

## M2: tier 別リプレイ + ジャッジ + Review UI

**ゴール**: 1 バッチ完走し、variant 間の勝敗と human-judge κ が数字で出る。

- [ ] `shifter`: decide 実装(agent_step 判定 + sticky 状態。ポリシーは手書きのテスト用で可)
- [ ] `gateway`: `X-MR-Variant` 対応(variant 別 Shifter インスタンス)
- [ ] `evals`:
  - [ ] worktree ライフサイクル(add → setup → run → 回収 → remove、finally 保証)
  - [ ] stage 3 replay: Agent SDK × 4 variant、直列、タイムアウト、429 中断・再開、verify_command
  - [ ] stage 4 judge: pairwise-v1、position 2 回、入力構成(before_context 切り詰め)、JSON 検証 + リトライ
- [ ] `datastore`: replay_runs / judgments / human_reviews / shift_events 追加
- [ ] `review-ui`: キュー・ブラインド比較(diff ハイライト、1 件版クイック比較 URL 込み)・κ 計算
- [ ] 初回バッチ(タスク 10 件 × 4 variant)→ 人間レビュー 20 件以上

**ゲート**: 4 variant 完走率 > 90%。human-judge κ ≥ 0.6。`mid+demote` で実際に降格が発生しゲート経由で記録されている(変速コードパスの実機検証)。

**想定外が出やすい所**(最大の山):
- Agent SDK のヘッドレス実行の癖(権限設定、cwd 制約、カスタムヘッダ可否)
- worktree で依存未インストールのままエージェントが右往左往 → setup_commands 整備
- ジャッジが diff の大きさに釣られる → efficiency 基準強調、verify 結果の重み付け
- Haiku がタスクを完走できずターン暴走 → timeout と turns 上限、これも「low の実力データ」として記録
- κ が出ない → カテゴリを絞る / 基準を具体化 / tie 許容度を上げる、の順で調整

## M3: 集計 + レポート + ポリシー生成

**ゴール**: 「カテゴリ × variant の勝敗表」と shift-policy.yaml が毎バッチ自動で出る。

- [ ] stage 5 aggregate: 判定集約(human_reviews による上書き込み)、Wilson CI、avg_turns / avg_total_tokens、tier_profiles
- [ ] stage 6 report: Markdown レポート(降格判定表・昇格判定表)+ ポリシー生成(閾値 + 変更予算 + overrides マージ)+ policy_changelog 記録
- [ ] `scripts/notify.ts`(osascript 通知、review-ui への URL 付き)+ changelog サマリ通知
- [ ] 定期実行化(launchd: 夜間に `--stage all`、枠ガードで自走)
- [ ] 2〜3 バッチ蓄積(カテゴリ n ≥ 10)

**ゲート**: 降格候補・昇格候補が最低 1 つずつ判定できる(「該当なし」も結論として可 — その場合は変速なし = プロジェクトは可視化ツールとして完成)。

## M4: 変速の本番有効化

**ゴール**: 降格 → 昇格の順に段階投入し、正味効果を計測。

- [ ] `shifter`: governor(枠ガバナー・自動デグレード)、SIGHUP リロード
- [ ] `gateway`: shifting モード統合、書き換え起因 4xx の透過再試行、stats 拡張(変速内訳・キャッシュ比較)
- [ ] ロールアウト:
  1. `demote.agent_step` のみ → 3 日監視(エラー率 < 1%)
  2. キャッシュ計測: 前後 1 週間で cache_read 率・モデル別トークン比較 → **正味プラス確認**
  3. カテゴリ降格 → 3 日 → 昇格(plan / debug)→ 1 週間体感確認
- [ ] 問題ルールは overrides で即無効化(手順の実地確認)

**ゲート**: 1 週間で体感品質の劣化なし、エラー率 < 1%、キャッシュ損 < 変速益(数字で確認)。

## M5: 自己進化ループ(本プロジェクトのキモ。詳細仕様は 07)

**ゴール**: ログを常に参照して自分で最適化し続け、人間の意思が注意予算内で反映される状態。

### 自動ループ

- [ ] 夜間ジョブ `evals -- nightly`: 暗黙シグナル集計(ESC 中断率・訂正プロンプト率の gear × カテゴリ別)、劣化判定 → ルール自動サスペンド、新モデル検知(未知 model_requested パターン)、日次スナップショット
- [ ] 訂正マーカー検出の実装と較正(「違う」「そうじゃなくて」「やり直し」等。誤検出率を目視確認)
- [ ] 自動ロールバック: サスペンド → changelog(origin: auto_rollback)→ 通知 → 復帰は次バッチ再検証
- [ ] ドリフト検知: バッチ間で win_rate が CI を超えて動いたカテゴリを警告
- [ ] 新モデル対応の実演: models.yaml の tier 差し替え 1 行 → 自動再評価 → ポリシー再生成(07 のシナリオを 1 回実走)

### 人間ループ

- [ ] `feedback.yaml`(注意予算・通知・変更統治)+ config ローダー
- [ ] stage 7: A/B 選好キュー生成(優先度 = 影響度 × 不確実性)、週 3 問の予算管理、期限切れ処理 (`preference_queue` への予算内 enqueue は実装済み)
- [ ] 通知フロー: osascript → review-ui クイック比較 → human_reviews(source='push')
- [ ] `bun run feedback -- add` CLI + `skills/model-feedback/SKILL.md` (`add` / `list` と `feedback_notes` 保存口は実装済み)
- [ ] フィードバック取り込み: LLM 解釈(parsed_json)→ 変更案生成 → review-ui 提案ページで承認/却下 → 反映 + changelog(origin: human_feedback)
- [ ] 満足度チェック(月 1 問): 通知 → 満足度ページ → 「止めたい」は即 passthrough 化
- [ ] `bun run policy -- rollback <version>`(即時巻き戻し)

M5 の初期実装では `config/feedback.yaml` の Zod loader、`bun run evals -- nightly` の日次 Markdown、`bun run evals -- run --stage feedback` の `preference_queue` enqueue、`bun run feedback -- add` / `list` の保存口、`bun run policy -- rollback <policy-file>` を先に提供する。通知・自動 suspend・提案承認 UI はこの基盤に後続で接続する。

### 継続較正

- [ ] 枠モデル較正: quota_events 実測から window_burn 推定・eval_runs_per_window を調整
- [ ] judge プロンプト改善サイクル: κ 低カテゴリの不一致例を読み、pairwise-v2 を旧版と並走比較
- [ ] 効果レポート: 月次で「Opus 自動昇格の回数と場面」「Haiku 降格による正味トークン削減」「A/B 質問の回答率」「フィードバック反映リードタイム」

**ゲート**: A/B 質問の回答率 ≥ 60%。フィードバック → 反映 ≤ 1 週間。満足度チェックで「止めたい」が出ない。モデル世代交代シナリオを 1 回完走。

## 実装順の理由(依存関係)

```
Day1 スパイク ──▶ プロジェクト全体の Go/No-Go(最大リスクを最初に潰す)
M0 gateway + hooks ──▶ ログ蓄積(2〜4 週)──▶ M1 分類・母数実測 ──▶ M2 リプレイの元ネタ
M2 shifter(variant 適用)──▶ M4 で本番ポリシーに流用(評価で先に実戦検証済みの状態)
M2 κ ゲート ──▶ M3 プロファイル信頼性 ──▶ M4 ポリシーの根拠
```

**最初に書くコードはスパイク、次に gateway の素通しプロキシと hooks。**

## 見積もり(参考)

| フェーズ | 実装 | 運用待ち |
|---|---|---|
| M0 | スパイク 0.5〜1 日 + 本体 3〜4 日 | +1 週間(ログ蓄積) |
| M1 | 2〜3 日 | — |
| M2 | 5〜7 日(worktree 管理と judge が重い) | +レビュー 1〜2 時間 |
| M3 | 2〜3 日 | +2〜3 週(バッチ蓄積) |
| M4 | 2〜3 日 | +2 週間(段階ロールアウト・計測) |
| M5 | 5〜7 日(夜間ジョブ・選好プッシュ・フィードバック取り込み)+ 以後は継続運用 | — |

金銭コスト追加ゼロ(既存 Max サブスクのみ)。予算は**枠と夜間実行時間**: 1 バッチ(タスク 10 × 4 variant + ジャッジ 60 判定)を夜間 1〜2 ウィンドウで消化する設計。
