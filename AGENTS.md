# AGENTS.md — 実装エージェント向けガイド

このリポジトリは「Claude Code のオートマチックトランスミッション」(タスクに応じた Claude モデルの自動変速)を実装するプロジェクト。**実装レベルの設計が docs/ に完備されている。設計を読まずにコードを書かないこと。**

## 最重要ルール

1. **実装前に該当設計を読む。** 何をどの順で作るかは [docs/06-implementation-plan.md](docs/06-implementation-plan.md) のマイルストーン(Day 1 スパイク → M0 → M1 → …)に従う。各コンポーネントの仕様は対応する docs を参照:
   - Gateway / hooks → [docs/03-gateway.md](docs/03-gateway.md)
   - DB スキーマ → [docs/02-data-model.md](docs/02-data-model.md)(DDL はここが正)
   - 評価パイプライン → [docs/04-evaluation-pipeline.md](docs/04-evaluation-pipeline.md)
   - 変速機(shifter) → [docs/05-routing-engine.md](docs/05-routing-engine.md)
   - フィードバック/自己進化 → [docs/07-feedback-and-evolution.md](docs/07-feedback-and-evolution.md)
   - 設定ファイル仕様・リポジトリ構成 → [docs/01-architecture.md](docs/01-architecture.md)
2. **設計から逸脱する場合は、コードより先に docs を更新する。** 実装中の発見で設計を変えるのは健全だが、黙って乖離させない。docs の変更は同じ PR に含め、コミットメッセージに理由を書く。
3. **マイルストーンの Go/No-Go ゲートを勝手に飛ばさない。** 特に Day 1 スパイク(OAuth での model 書き換え検証)の結論が出る前に M0 本体を作り込まない。スパイク結果は `docs/decisions.md` に記録する。
4. **外部 API・CLI のフラグやフィールド名は実装時に最新ドキュメントで確認する。** docs 内の Claude Agent SDK オプション名・hooks の入力 JSON フィールド・モデル ID は「実装時に要確認」の目印付き。推測で書かない。
5. **作業開始前に `docs/reviews/` を確認する。** 実装はレビュアー(Claude)によるレビューを受け、指摘が `docs/reviews/<日付>-<対象>.md` に残る。未対応の指摘([重要]/[中])がある場合は**新機能より先に対応する**。[軽] や「M0 送り」等と明記された指摘は、該当マイルストーンの実装時に必ず拾う。対応したら該当レビューの指摘番号をコミットメッセージ or PR 説明で参照する(例: `fix(spike): レスポンスヘッダの encoding 不整合を解消 (reviews/2026-07-06-day1-spike.md #1)`)。

## 絶対に守る安全原則(レビューで必ず見られる)

- **認証情報(OAuth トークン、`authorization` / `x-api-key` ヘッダ)をログ・DB・ファイルに書かない。** ヘッダの保存は許可リスト方式(`user-agent`, `anthropic-version`, `anthropic-beta` のみ)。
- **プロキシは素通しが基本。** 上流へのヘッダは無加工(`host` のみ書き換え)。パース不能なボディは warn ログして素通し。
- **SSE は逐次 flush。** 中継にバッファリングを挟むと Claude Code の体感が壊れる。ログ用の tee は返却をブロックしない。
- **迷ったら素通し。** shifter のあらゆる分岐は「判定不能 → 現状維持(hold)」に倒す。
- **キルスイッチ(`MODEL_ROUTING_DISABLED=1`)と passthrough モードは常に機能すること。**
- gateway は 127.0.0.1 バインドのみ。`/internal/*` と `X-MR-Variant` は localhost 由来のみ受理。

## 技術スタック(固定。勝手に変えない)

- Bun(runtime / workspaces / test runner / `bun:sqlite`)。Node・pnpm・vitest は使わない
- TypeScript ESM only(`"type": "module"`)
- Hono v4(Review UI は Hono JSX SSR。SPA・フロントエンドフレームワークは導入しない)
- Drizzle ORM + `drizzle-kit`(SQLite は WAL モード)
- Zod v4(全 config はロード時検証、不正なら起動失敗)
- Biome 2(lint + format)
- 評価リプレイは Claude Agent SDK(サブスク認証継承)。**従量課金 API・API キーは一切使わない**

## 実装規約

- ID は UUIDv7。リクエスト/実行/判定はすべて ID で突合可能にする
- 生ボディ・成果物は DB に入れない(メタは SQLite、実体は zstd 圧縮で `data/` 配下)
- `data/` は gitignore(SQLite・ボディ・成果物・レポート)
- パッケージ依存の方向は docs/01 の図に従う(`shared` は何にも依存しない、`shifter` は DB に依存しない、など)
- バッチ処理(evals)は冪等に作る(status カラムで進捗管理、再実行で続きから)
- テスト: SSE 再構成・特徴量抽出・classifyHeuristic・Wilson CI などの純ロジックはユニットテスト必須。gateway はモック上流(`UPSTREAM` 差し替え)での E2E を用意

## 検証

```bash
bun test              # 全テスト
bun run lint          # Biome
```

gateway に触れる変更は、モック上流 E2E に加えて「実際に `ANTHROPIC_BASE_URL` を向けて `claude -p` が streaming で完走する」ことを確認してから完了とする。

## コミット / PR

- コミットは Conventional Commits(例: `feat(gateway): SSE 中継とログ記録`)。本文は日本語で可
- 1 PR = 1 マイルストーン内のまとまった単位。設計変更を含む場合は docs 更新を同 PR に含める
- PR 説明には「対応する docs の節」と「ゲート条件への影響」を書く(レビューは設計準拠を最優先で見る)
