# 01. アーキテクチャとリポジトリ構成

## リポジトリ構成(Bun workspaces モノレポ)

```
model-routing/
├── docs/                      # 設計ドキュメント(本フォルダ)
├── config/
│   ├── models.yaml            # Claude モデル階級(tier)レジストリ(手書き)
│   ├── eval.yaml              # 評価パイプライン設定(手書き)
│   ├── feedback.yaml          # 注意予算・通知・変更統治の設定(手書き。07 参照)
│   ├── shift-policy.yaml      # 変速ポリシー(M3 以降は aggregator が生成)
│   └── prompts/
│       ├── classify-v1.md     # タスク分類プロンプト
│       └── pairwise-v1.md     # ペアワイズ比較プロンプト
├── packages/
│   ├── shared/                # 型・タクソノミー・config ローダー(Zod)・共通ユーティリティ
│   ├── datastore/             # Drizzle スキーマ・マイグレーション・リポジトリ層
│   ├── gateway/               # プロキシ本体(ingress / logger / shifter 組み込み)
│   ├── shifter/               # 変速エンジン(heuristic classifier / policy / 枠ガバナー)
│   ├── evals/                 # sampler / classifier / replayer / judge / aggregator
│   │                          #   + nightly(ログ監視)/ stage 7(フィードバック取り込み)
│   └── review-ui/             # 人間検証 + A/B クイック比較 + 提案承認 + 満足度(Hono JSX SSR)
├── hooks/                     # Claude Code 用 hook スクリプト(タスク境界・repo 状態通知)
├── skills/
│   └── model-feedback/        # /model-feedback skill(feedback CLI の薄いラッパー)
├── scripts/                   # 運用スクリプト(db-init, spike-rewrite, log-explorer, notify, prune 等)
├── data/                      # SQLite・圧縮ボディ・リプレイ成果物(gitignore)
│   ├── model-routing.db
│   ├── bodies/
│   ├── runs/
│   └── reports/
├── package.json               # "workspaces": ["packages/*"]
├── bunfig.toml
├── biome.json
└── tsconfig.base.json
```

### パッケージ間依存

```
shared ◀── datastore ◀── gateway ◀── (組み込み) shifter
   ▲            ▲    ◀── evals
   │            └─── ◀── review-ui
   └── shifter / evals / review-ui すべて shared に依存
```

- `shared` は何にも依存しない(型・純関数のみ)。
- `shifter` は DB に依存しない(ポリシーとメモリ内状態のみで判断。記録は gateway の責務)。
- `evals` / `review-ui` は gateway と独立プロセス(バッチ/随時)。

## プロセス構成

| プロセス | 起動 | 常駐 |
|---|---|---|
| gateway | `bun run gateway`(launchd 化は任意) | ✅ |
| evals(週次) | `bun run evals -- run --stage all`(launchd 夜間) | ❌ バッチ |
| evals(夜間監視) | `bun run evals -- nightly`(launchd 毎夜) | ❌ バッチ |
| review-ui | `bun run review-ui`(通知クリックで開く先。常駐させても軽い) | 任意 |
| feedback CLI | `bun run feedback -- add "..."` / `/model-feedback` skill | ❌ 随時 |

### Claude Code 側の設定

```bash
# ~/.zshrc など
export ANTHROPIC_BASE_URL="http://localhost:8484"
# 緊急時はこの環境変数を外すだけで素の接続に戻る
```

- サブスク(OAuth)の認証ヘッダはそのまま素通し。gateway は認証情報を保存しない。
- `hooks/notify-task.ts` を Claude Code の hooks(UserPromptSubmit)に登録し、タスク境界・`cwd`・`git HEAD` を gateway に POST する([03-gateway.md](03-gateway.md#hooks-companion))。**変速機がタスク境界を知るための唯一の情報源**なので、単なるログ用途ではなく準必須コンポーネント。

## 設定ファイル仕様

### config/models.yaml(tier レジストリ)

```yaml
# Claude Code が送ってくるモデル ID を tier に正規化し、変速先を解決する
tiers:
  high:
    model: claude-opus-4-8            # 実装時に最新 ID を確認
    match: ["claude-opus-*"]          # model_requested の正規化用パターン
  mid:
    model: claude-sonnet-5
    match: ["claude-sonnet-*"]
  low:
    model: claude-haiku-4-5-20251001
    match: ["claude-haiku-*"]

# Claude Code が雑務(タイトル生成等)に使う低モデル指定には一切介入しない
never_touch:
  - "claude-haiku-*"       # model_requested がこれなら常に素通し

subscription:
  window_hours: 5           # Max プランのレート制限ウィンドウ(体感較正用)
  eval_runs_per_window: 20  # 評価バッチが 1 ウィンドウで使ってよい実行数
```

> モデル ID・ウィンドウ仕様は**実装時に最新ドキュメントで確認**して埋める。次期モデルが出たら `tiers.*.model` を差し替えるだけで移行できる構造にする。

### config/eval.yaml(評価設定)

```yaml
sampling:
  per_batch: 20                 # 1 バッチのタスク数
  per_category_min: 3
  self_contained_only: true     # 自己完結タスクのみ(02 参照)
  max_task_prompt_chars: 8000
  dedup_window_days: 30
  exclude_repos: []             # 機密 repo の除外(必要に応じて)

replay:
  variants:                     # 各タスクをこの4通りで再実行して比較する
    - id: high        # 全ターン Opus
    - id: mid         # 全ターン Sonnet(= baseline)
    - id: low         # 全ターン Haiku
    - id: mid+demote  # Sonnet + 変速機の降格ルール適用(本番想定の挙動)
  baseline: mid
  isolation: worktree
  timeout_minutes: 15
  concurrency: 1
  verify_commands: {}           # repo パス → 客観チェックコマンド(任意)
  setup_commands: {}            # repo パス → 依存インストール(任意)

judge:
  primary: high                 # Opus(Agent SDK、ツール無効)
  position_swap: true           # A/B 入替 2 回判定。不一致は tie
  # Claude 同士の比較なので judge も Claude 1 系統で足りる。
  # その分、人間抜き取り率を上げて信頼性を担保する

human_review:
  sample_rate: 0.25             # judge が 1 系統なので抜き取りは厚め(25%)
  low_margin_always: true       # position 入替で判定が割れたペアは全件人間行き

schedule:
  allowed_hours: [0,1,2,3,4,5,22,23]   # 開発枠の保護
  pause_on_rate_limit: true

policy_generation:              # M3 のポリシー生成閾値(05 参照)
  demote_min_n: 10
  demote_wilson_low: 0.40       # 「Haiku 系が baseline にほぼ負けない」
  promote_min_n: 10
  promote_wilson_low: 0.55      # 「Opus が明確に勝つ」(昇格は枠を食うので高め)
  min_kappa: 0.6
```

### config/shift-policy.yaml(生成物)

M3 の aggregator が書き出す。手編集は `overrides` 節のみ。フォーマットは [05-routing-engine.md](05-routing-engine.md#ポリシーファイル)。

## 評価リプレイの経路(重要な設計判断)

評価の再実行は **Claude Agent SDK を `ANTHROPIC_BASE_URL=gateway` で起動**して行う:

```
evals(replayer)
  └─ Agent SDK query({ model: tier, cwd: worktree })
        └─ ANTHROPIC_BASE_URL=http://localhost:8484?  ← gateway 経由
              └─ gateway: variant に応じたポリシーを適用(X-MR-Variant ヘッダで指定)
                    └─ api.anthropic.com(サブスク認証は SDK が持つ)
```

利点:
1. `mid+demote` variant で**本番とまったく同じ変速コードパス**を検証できる(ルールの机上検証ではなく実機検証)
2. リプレイのリクエストも requests テーブルに記録され、ターン数・トークン・キャッシュ挙動が本番と同じ粒度で取れる
3. 評価専用の実行経路を別途作らなくてよい

gateway は `X-MR-Variant` ヘッダ(localhost のみ受理)を見て「このリクエスト列にどのポリシーを適用するか」を切り替える。ヘッダなし = 本番トラフィック。

## 横断的な設計原則

1. **ホットパスに LLM 呼び出し・DB 読みを入れない。** 変速判断はヒューリスティック + メモリ内ポリシーで 1ms 未満。LLM 分類はオフライン専用。
2. **すべてのリクエスト/実行に UUIDv7 を採番**し、ログ・評価・変速判断を突合可能にする。
3. **生ボディ・成果物は DB に入れない**(メタは SQLite、実体は zstd ファイル)。
4. **設定は Zod でロード時検証**、不正なら起動失敗。
5. **認証情報はログ・DB・ファイルに絶対に書かない**(ヘッダ記録は許可リスト方式)。
6. **迷ったら素通し。** 変速機のあらゆる分岐は「判定不能 → 現状維持」に倒す。
