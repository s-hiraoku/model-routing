# model-routing

**Claude Code のオートマチックトランスミッション** — ユーザーがモデルを一切意識しなくても、タスクに応じて最適な Claude モデルが選択されてアウトプットが出る体験を作るプロジェクト。

```
設計・難しいデバッグ → Opus に自動シフトアップ(品質が要る場面で勝手に上がる)
通常の実装          → Sonnet(デフォルト)
ツール実行の中間ターン → Haiku に自動シフトダウン(サブスク枠を温存)
```

体感上の変化は「Opus 品質が必要な場面で勝手に Opus になっている」「Max サブスクの枠が減りにくくなった」だけ。それ以外は今まで通り Claude Code を使うだけ。

## 仕組み

Claude Code → api.anthropic.com のトラフィックをローカルプロキシ(gateway)で素通しし、`model` フィールドだけを書き換える。認証はサブスク(OAuth)をそのまま通すので、**従量課金 API は一切使わず、既存の Claude サブスクだけで完結する**。

```
┌─────────────┐  ANTHROPIC_BASE_URL   ┌──────────────────┐
│ Claude Code  │ ────────────────────▶│  Gateway (proxy)  │──▶ api.anthropic.com
│ (普段の開発)  │                       │  logger + 変速機   │
└──────┬──────┘                       └────────┬─────────┘
       │ hooks(タスク境界・git HEAD)             ▼
       └────────────────────────────▶   SQLite(全ログ)
                                              │
                              評価パイプライン(実タスクを worktree で
                              tier 別に再実行 → LLM-as-Judge → 集計)
                                              │
                                              ▼
                                     変速ポリシー(自動生成)
```

### 何を根拠に変速するのか

ベンチマークではなく**自分の実開発ログ**。実際に投げたタスクをサンプリングし、git worktree で隔離した同一 repo 状態の上で Opus / Sonnet / Haiku / 変速あり の 4 通りで再実行して成果を比較する。「どのタスクなら Haiku に降ろしても壊れないか」「どのタスクは Opus に上げる価値があるか」を統計的に判定してから変速ルールを有効化する。

### 自己進化(このプロジェクトのキモ)

モデルは次々と世代交代するので、変速ロジックは静的なルール集ではなく**自分で最適化し続ける**:

- **自動ループ**: 夜間のログ監視(中断率・訂正プロンプト率・新モデル検知・劣化検知)+ 週次の再評価 → ポリシー自動再生成。劣化したら自動ロールバック
- **人間ループ**: 「注意予算」内で意思を吸い上げる — A/B 選好質問は週 3 問まで(通知クリック → 1 分のブラインド比較)、満足度確認は月 1 問、`/model-feedback` でいつでも自由記述の要望。overrides は絶対的拒否権として何世代進化しても保持

次期モデルが出たら、設定 1 行の変更だけで自動再評価 → ポリシー再適応まで回る。

## ステータス

**M0 コード実装完了・運用ゲート確認中。** 実装レベルの設計は [docs/](docs/) にある:

| ドキュメント | 内容 |
|---|---|
| [00-overview](docs/00-overview.md) | コンセプト・ロードマップ・リスク |
| [01-architecture](docs/01-architecture.md) | システム構成・リポジトリ構成・設定ファイル |
| [02-data-model](docs/02-data-model.md) | DB スキーマ(DDL)・タスクタクソノミー |
| [03-gateway](docs/03-gateway.md) | プロキシ + hooks companion 仕様 |
| [04-evaluation-pipeline](docs/04-evaluation-pipeline.md) | 評価パイプライン(サンプリング〜ジャッジ〜集計) |
| [05-routing-engine](docs/05-routing-engine.md) | 変速機(shifter)仕様 |
| [06-implementation-plan](docs/06-implementation-plan.md) | マイルストーン別タスク分解 |
| [07-feedback-and-evolution](docs/07-feedback-and-evolution.md) | **自己進化ループと人間フィードバック(キモ)** |

### ロードマップ

- [x] **Day 1 スパイク**: サブスク OAuth で model 書き換えが通るかの検証(プロジェクト全体の Go/No-Go)
- [ ] **M0**: 透過プロキシ + 全ログ記録 + hooks(1 週間の実運用テスト)
- [ ] **M1**: タスク分類器 + サンプラー
- [ ] **M2**: tier 別リプレイ + LLM-as-Judge + Review UI(人間一致率 κ ≥ 0.6 ゲート)
- [ ] **M3**: 集計 + 変速ポリシー自動生成
- [ ] **M4**: 変速の本番有効化(降格 → 昇格の順に段階投入)
- [ ] **M5**: 自己進化ループ(夜間監視・選好プッシュ・フィードバック取り込み・自動ロールバック)

## 技術スタック

Bun(runtime / workspaces / test / `bun:sqlite`)· TypeScript · Hono v4 · Drizzle ORM · Zod v4 · Biome 2 · Claude Agent SDK(評価リプレイ用。サブスク認証を継承)

## Day 1 スパイク

OAuth サブスク認証のまま `/v1/messages` の `model` 書き換えが成立するかを検証する。

```bash
REWRITE_MODEL="<target-model-id>" bun run spike:rewrite
ANTHROPIC_BASE_URL="http://127.0.0.1:8484" claude -p "1+1は?"
```

必要に応じて `PORT` と `UPSTREAM` で待受ポート・上流 URL を差し替えられる。

検証結果は [docs/decisions.md](docs/decisions.md) に記録する。

## 現在使えるコマンド

```bash
bun install
bun run db-init
bun test
bun run lint
bun run gateway              # localhost:8484, passthrough + /v1/messages metadata logging
bun run log-explorer -- recent --limit=20
bun run log-explorer -- stats
bun run prune -- --dry-run
```

M0 のコード実装は完了済み。残る M0 ゲートは、実際に `ANTHROPIC_BASE_URL` を gateway に向けた日常運用を 1 週間行い、エラー率・体感遅延・`task_events`・`stats` を確認すること。

Claude Code の `UserPromptSubmit` hook には、必要に応じて以下を登録する。

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/model-routing/hooks/notify-task.ts"
          }
        ]
      }
    ]
  }
}
```

## 使い方(M0 完了後)

```bash
bun install
bun run db-init
bun run gateway              # localhost:8484

# Claude Code 側(~/.zshrc など)
export ANTHROPIC_BASE_URL="http://localhost:8484"
# 緊急時はこの環境変数を外すだけで素の接続に戻る
```

## 設計上の割り切り

- **Claude ファミリー内に限定。** マルチプロバイダー(GPT/Gemini)は当初構想にあったが、サブスクのみの制約下では他社モデルをリクエスト経路の内側に入れられず、タスク委譲方式は「継ぎ目」が見えて「モデルを意識しない」という目的と矛盾するため捨てた(経緯は [00-overview](docs/00-overview.md#スコープ決定の経緯重要))
- **迷ったら素通し。** 変速は「確実に得する場合だけ介入する」オプトイン動作。判定に迷うリクエストは全部そのまま通す
- **壊れても開発が止まらない。** キルスイッチ(`MODEL_ROUTING_DISABLED=1`)、パススルーモード、環境変数を外せば素の接続
