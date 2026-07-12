# レビュー: M5 追加機能 6 コミット + プロセス監査

- 対象: `a3c4ec8`〜`f96628b`(feedback 提案生成/承認/適用、auto-suspend、drift レポート、model-handoff)
- レビュアー: Claude(設計準拠レビュー)
- 日付: 2026-07-12
- 判定: **新機能のコード品質は概ね良好(テスト 89 件パス、docs 同時更新)。しかし進め方が誤っている。** 前回レビュー(2026-07-07)の[重要] 5 件が 1 件も対応されないまま新機能が積まれた。AGENTS.md ルール 5「未対応の[重要]/[中]は新機能より先に対応する」への明確な違反。**これ以上の新機能実装を凍結し、レビューバックログ消化 → M0 運用ゲート開始に切り替えること。**

## 1. プロセス監査(最重要)

### 前回[重要]指摘の対応状況(2026-07-12 時点)

| # | 指摘 | 状態 |
|---|---|---|
| 1 | client_abort 中断でリクエスト記録が消える | ❌ 未対応(`readStreamText` 無防備のまま) |
| 5 | sessionState がグローバル 1 個(セッション混線) | ❌ 未対応 |
| 6 | activeReplay 中の本番トラフィック汚染 | ❌ 未対応(`/internal/replay-begin` 方式のまま) |
| 7 | リプレイの `permissionMode: "default"` | ❌ 未対応(replay.ts:113) |
| 8 | thinking ブロック入り会話の降格互換の実機検証 | ❌ 未実施(decisions.md に追記なし) |
| 9 | governor 未実装 | ❌ 未対応(スキーマのみ、decideShift 参照なし) |

一方で 07-08 に M5 新機能が 6 コミット積まれている。**新機能の一部は未修正の土台に直接依存している**(例: preference push は judge 結果を配るが、その judge 結果は permissionMode 問題で「ツールを使えないエージェント同士の作文比較」になる。auto-suspend は shifted エラーを見るが、セッション混線下の shift_events は信頼できない)。

### M0 運用ゲートが未開始

`data/model-routing.db` の最終更新は **07-06 16:13、requests 4 件・task_events 1 件**(いずれも動作確認時のもの)。つまり 6 日間、gateway は実開発に使われていない。現状:

- **全パイプライン(M1〜M5)は実データゼロで動いたことがない。** ゲート(M1 分類 80%、M2 κ、M3 有意差、M4 段階投入)はどれも開始条件すら揃っていない
- このプロジェクトのキモ(ログを常に参照する自己進化)は、ログが流れて初めて意味を持つ。**今の律速はコードではなくデータ**

## 2. 新機能 6 コミットへの指摘

一次レビューの範囲では大きな欠陥なし。以下のみ:

### 2-1. [中] ポリシー changelog が DB ではなく JSON ファイル

`scripts/policy.ts` は changelog を `data/reports/feedback-policy-changelog.json` に書くが、docs/02 は `policy_changelog` テーブル(origin / evidence / notified_at 付き)を定義している。changelog は自己進化の監査ログであり、drift レポートや通知(M5 後続)が参照する中心データなので、**DB テーブルに寄せる**こと(または docs/02 を改訂して理由を書く)。auto-suspend(nightly --policy)側の記録先も同様に統一する。

### 2-2. [軽] `overrides.action=force` は設計に反映済みで良い

docs/05 に追記されており AGENTS ルール 2 遵守。人間承認を経る流れも設計どおり。

## 3. 指示(この順で。完了まで新機能コミット禁止)

1. **[即] 指摘 1(client_abort 記録)修正** — M0 運用開始のブロッカー
2. **[即] M0 運用ゲート開始**(これは人間側の作業も含む):
   ```bash
   bun run db-init && bun run gateway        # 常駐起動(launchd 化推奨)
   export ANTHROPIC_BASE_URL="http://localhost:8484"   # ~/.zshrc
   # hooks 登録: ~/.claude/settings.json に UserPromptSubmit → hooks/notify-task.ts
   ```
   1 週間後に `/internal/stats` でゲート判定(エラー率・キャッシュ率・task_events)
3. 指摘 7(permissionMode)+ 6(リプレイ専用 gateway インスタンス方式)を修正
4. 指摘 8 の実機検証: ツール使用タスク 1 件で `mid+demote` リプレイ → thinking ブロック降格が 400 になるか decisions.md に記録
5. 指摘 5(セッション状態の session 単位化)+ 9(governor 実装)— M4 有効化の前提
6. 2-1(changelog の DB 化)

## 4. 良かった点

- 新機能にも docs 同時更新・テストが伴っている(89 件パス・lint クリーン)
- `apply-feedback` が人間承認済み提案のみ適用し、適用前にポリシーをバックアップコピーしている
- `model-handoff` はモデル世代交代シナリオ(docs/07)を具体的な手順に落としており、方向性が正しい
- ledger による進捗管理は監査しやすい(このレビューの対応状況確認も ledger で高速化できた)

## 5. レビュアーからの運用提案

Codex は「コードを書く」方向に強く進むが、ゲートを跨ぐ判断は人間+レビュアー側で握る必要がある。以後の運用として、**各マイルストーンのゲート判定はレビュー(docs/reviews/)で明示的に「ゲート通過」を宣言してから次へ進む**ことを提案する。AGENTS.md には既にルール 3(ゲートを勝手に飛ばさない)があるが、「コード完了 ≠ ゲート通過」の区別を ledger にも明記させる。
