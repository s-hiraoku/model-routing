# レビュー: M0 完了判定 + M1〜M5 先行実装の一次レビュー

- 対象: `379cc48`(M0 レビュー対応)〜 `6293e09`(M5 進捗)の 18 コミット
- レビュアー: Claude(設計準拠レビュー)
- 日付: 2026-07-07
- 判定:
  - **M0: コードとしては合格。** スパイク追試(`output_config.effort` 除去で降格成立)も完了・記録済み。ただし運用ゲート(1 週間実走)が未実施なので M0 クローズはまだ。**指摘 1 を直した上で、今日から `ANTHROPIC_BASE_URL` を向けて運用を開始すべき**
  - **M1〜M5 先行実装: 一次レビューで重要 4 件。** 特に M4(変速有効化)・M2(リプレイ実行)の前に必須の修正がある。コード先行自体は docs 更新も伴っており許容するが、**ゲート(M1 分類 80% → M2 κ ≥ 0.6 → M4 段階投入)は実データで順番に実施すること**

## 前回指摘への対応状況

- ✅ #1 スキーマ二重管理 → drizzle-kit 生成 migration を db-init の入力に一本化(`379cc48`)
- ✅ スパイク追試 → `output_config.effort` 除去で Haiku 降格 200 を実機確認、`strip_params` として設計・実装に反映。decisions.md の記録も具体的で良い
- ✅ 上流エラーハンドリング / hop-by-hop 除去 / kill switch 統一

## M0 の残指摘(運用開始前に 1 件、開始後で可が 3 件)

### 1. [重要] streaming 中のクライアント中断でリクエスト記録が丸ごと消える

`app.ts` の `logMessagesRequest` は tee した `logBody` を全読みするが、ユーザーが ESC で中断すると `req.signal` → 上流 fetch が abort → `logBody` の読みが reject → `.catch(console.warn)` で**行そのものが記録されない**。ESC 中断は高頻度の正常系であり、これが欠落すると:

- 1 週間ゲートの「エラー率(client_abort 除く)」の分母・分子が両方壊れる
- 中断率は暗黙シグナル(07 の訂正プロンプト率と並ぶ劣化検知材料)なのに観測不能になる

対応: `readStreamText` の失敗を catch し、それまでに読めた分で `status='client_abort'` として記録する(部分ボディでよい)。**運用開始前に修正**。

### 2. [中] zstd が外部バイナリ依存 + リクエスト毎に一時ファイル & プロセス spawn

`body-store.ts` が `Bun.spawn(["zstd", ...])`。zstd CLI 未インストール環境で全ログが落ちる上、毎リクエストの spawn + 一時ファイル書き込みは重い。Bun 組み込みの zstd 圧縮 API(`Bun.zstdCompressSync` 等。**利用可否をバージョンで確認**)へ置き換え、なければ `node:zlib` の gzip に落とす(拡張子も実態に合わせる)。

### 3. [軽] prompt_hash の定義が設計とズレ(直近 user テキストのみのハッシュ)

docs/02 は「messages 全体の正規化ハッシュ(dedup 用)」。`features.ts` は lastUserText のハッシュなので、「続けて」のような定型文で衝突する。requests 側の用途では実害が小さいが、docs を直すか実装を寄せるか、どちらかに揃えること(AGENTS ルール 2)。

### 4. [軽] hooks の git 実行に時間上限がない

`notify-task.ts` は POST に 500ms 上限がある一方、`git status --porcelain` 等は無制限。UserPromptSubmit はプロンプト処理をブロックするので、巨大 repo・コールド FS で全プロンプトが遅くなり得る。git spawn にも合計 ~300ms のデッドラインを付け、超えたら git 情報なしで送る。

## M1〜M5 先行実装の一次レビュー

### 5. [重要] sessionState がプロセス全体で 1 個(セッション混線)

`createGatewayApp` 内の `sessionState` は単一オブジェクトで、**全セッション・サブエージェント・並行ウィンドウの全リクエストが同じ状態を書き換える**。さらに `applyPolicyShift` は never_touch(haiku 雑務)リクエストでも `demotedStreak` を更新する。並行トラフィックで streak と currentGear が混線し、誤降格・誤 sticky が起きる。設計(docs/03)は `sessionState[session_id]`。task_event との紐付けヒューリスティック(時刻近接等)含め、**M4 有効化前に必須**。紐付け不能リクエストは「タスク文脈不明 = 触らない」に倒すこと。

### 6. [重要] activeReplay 中、localhost の全トラフィックが replay variant 扱いになる

`resolveReplayVariant` は active replay 期間中(最長 30 分)の**あらゆるローカルリクエスト**に variant を適用する。gateway は 127.0.0.1 バインドなので全トラフィックがローカル。リプレイ中に普段の開発をすると、(a) 本番トラフィックに `mid+demote` が適用され、(b) その記録が `replay_run_id` 付きで評価データに混入する。

対応案(推奨): **リプレイは evals が専用 gateway インスタンスを別ポートで起動して使う**。`createGatewayApp` はライブラリなので数行で済み、activeReplay という共有状態そのものが不要になる。本番 gateway の `/internal/replay-begin` は廃止。docs/03 の該当節も更新。

### 7. [重要] リプレイの `permissionMode: "default"` では評価が成立しない

`evals/src/replay.ts` の Agent SDK 呼び出しが `permissionMode: "default"`。ヘッドレスでは編集・Bash が承認待ち→拒否になり、**全 variant が「ツールを使えないエージェント」として走る**。diff は空になり、比較は最終メッセージの作文勝負に堕ちる。設計(docs/04)は「worktree 内の編集 + Bash は自動承認」。`acceptEdits` 相当 + 許可ツールの限定(worktree 外への書き込み禁止)を **SDK の最新ドキュメントで確認して**構成すること。あわせて `replay_runs.turns / total_*_tokens` が null 固定な点も、`requests(replay_run_id)` の集計で埋める(降格の正味得失判定 avg_turns / avg_total_tokens が機能していない)。

### 8. [重要・要実機検証] thinking ブロック入り会話の途中降格は 400 になる可能性が高い

スパイクの降格成功は**新規会話の 1 ターン目**のみ。本番の agent_step 降格は「fable-5 が thinking 付きで積んだ会話履歴を Haiku に送る」形になり、thinking ブロックの署名はモデル系列に紐づくため拒否される可能性がある。degrade_guard(元モデルで再試行)があるので事故にはならないが、**全 agent_step が 400+再試行になるなら降格は実質機能しない**(レイテンシ 2 倍だけ残る)。対応: (a) ツール使用タスクで `mid+demote` リプレイを実走して確認、(b) 400 が常態なら「降格時に thinking ブロック除去」等の追加変換を検討して設計に反映(これは挙動を変える変換なので、eval で品質検証してから)。

### 9. [中] governor が未実装(スキーマだけ存在)

`shiftPolicySchema` に `quota_guard` / `degrade_error_rate` / `degrade_pause_minutes` があるが、`decideShift` はどれも参照しない。枠逼迫時の昇格停止・ルール単位の自動サスペンド(docs/05)が無い状態で昇格を本番有効化しないこと。M4 の前提。

### 10. [軽] まとめ

- `x-mr-variant` ヘッダが上流へ転送される(docs/03 は「上流へは転送しない」)。`buildUpstreamHeaders` で除去
- replay の `mid+demote` は `min_consecutive: 1`、本番は 2 — 評価の方が過激なので方向は安全だが、「本番と同一コードパス」の主張には注記が要る(docs/04)
- 変速を見送った判断(将来の quota_governor 等)が shift_events に記録されない。「なぜ介入しなかったか」の説明可能性が設計原則
- worktree の後始末が finally 保証になっているか要確認(removeWorktree の呼び出し位置)

## 良かった点

- **スパイク追試 → strip_params 設計反映 → 実装、の流れが理想的**。decisions.md に「top-level effort では失敗、`output_config.effort` で成功」という切り分けまで記録されている
- degrade_guard の再試行が「レスポンスヘッダ受領後・ストリーム送出前」の正しい位置に入っている
- docs をコードと同時に更新し続けている(AGENTS ルール 2 遵守)。ledger による自己進捗管理も追跡しやすい
- テスト 84 件・lint クリーン。stats の shifted/unshifted キャッシュ比較など M4 ゲート計測の準備が先回りされている
- review-ui も 127.0.0.1 バインド

## 次のアクション(優先順)

1. 指摘 1(client_abort 記録)を修正 → **M0 運用ゲート開始**(`ANTHROPIC_BASE_URL` 切り替え + hooks 登録、1 週間)
2. 指摘 7(permissionMode)+ 6(専用 gateway 方式)を修正 → ログが貯まり次第 M1 ゲート(`audit-classify`)
3. 指摘 8 の実機検証(ツール使用タスクで mid+demote リプレイ)→ 結果を decisions.md へ
4. 指摘 5(セッション状態)+ 9(governor)は M4 有効化の前提条件として対応
