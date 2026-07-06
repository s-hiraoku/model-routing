# 03. Gateway(プロキシ)+ Hooks Companion 実装仕様

## 責務

1. Claude Code → api.anthropic.com のトラフィックを素通しし、全リクエスト/レスポンスを記録する
2. hooks からのタスク境界通知を受けて記録し、shifter のセッション状態に供給する
3. [M4] shifter の判断に従い `model` フィールドを書き換える(変速)
4. 評価リプレイのトラフィックを `X-MR-Variant` ヘッダで識別し、variant 別ポリシーを適用する

## 最優先事項: OAuth model 書き換えスパイク(実装初日)

プロキシ本体を作る前に、成立条件を最小コストで検証する。

`scripts/spike-rewrite.ts`(使い捨てスクリプト):

1. 数十行のミニプロキシを起動(Bun.serve、`/v1/messages` の model を固定書き換え、他は素通し)
2. `ANTHROPIC_BASE_URL=http://localhost:8484 claude -p "1+1は?"` を実行
3. 確認事項:
   - [ ] sonnet 指定 → haiku 書き換えで 200 が返る(レスポンスの `model` が haiku)
   - [ ] sonnet 指定 → opus 書き換えで 200 が返る(プラン上位モデルへの昇格が通るか)
   - [ ] streaming でも同様
   - [ ] 書き換え後も Claude Code の表示・後続ターンが壊れない
4. 結果を `docs/decisions.md` に記録

**昇格(→opus)だけ拒否される、等の部分的成立もあり得る。** その場合は降格専用機として設計を縮小継続。全滅なら Plan B(ログ・可視化ツール)へ。

## エンドポイント

| Method/Path | 動作 |
|---|---|
| `POST /v1/messages` | 記録 + 変速対象の本体。streaming / non-streaming 両対応 |
| 上記以外の `/*` | api.anthropic.com へ透過プロキシ(記録なし) |
| `POST /internal/task-event` | hooks からのタスク境界通知 |
| `GET /internal/healthz` | `{"status":"ok","mode":"passthrough\|shifting"}` |
| `GET /internal/stats` | 直近 24h: 件数・エラー率・変速内訳・キャッシュヒット率・推定枠消費 |

gateway は 127.0.0.1 バインドのみ。`/internal/*` と `X-MR-Variant` は localhost 由来でのみ受理。

## 動作モード

| モード | 挙動 |
|---|---|
| `passthrough`(M0 デフォルト) | 素通し + ログ記録 |
| `shifting`(M4 以降) | shift-policy に従い model 書き換え + ログ記録 |
| `MODEL_ROUTING_DISABLED=1` | 強制 passthrough(キルスイッチ) |

## リクエスト処理フロー

```
受信 POST /v1/messages
 │ 1. request_id 採番(UUIDv7)
 │ 2. ボディを Zod でパース(パース不能 → warn ログして素通し)
 │ 3. 特徴量抽出(message_count, tool_count, has_tool_results, hashes...)
 │ 4. variant 解決: X-MR-Variant ヘッダ(リプレイ)or 本番ポリシー
 │ 5. [shifting 時] shifter.decide(features, sessionState) → gear_to
 │      gear_to ≠ gear_from なら model 書き換え、shift_events 記録対象に
 │ 6. api.anthropic.com へ転送(認証・anthropic-beta 等のヘッダは無加工)
 │ 7. レスポンスを tee(クライアント逐次中継 + 記録用バッファ)
 │ 8. 完了後(非同期): SSE 結合 → Message 再構成 → SQLite + zstd 保存
 ▼
返却
```

### 実装ポイント

- **OAuth ヘッダの素通しが生命線。** `authorization` / `x-api-key` / `anthropic-*` を一切加工しない。`host` のみ書き換え。
- **SSE は逐次 flush**(バッファリング禁止。体感が壊れる)。Bun の fetch + ReadableStream パイプ、変換は挟まない。
- **ログ書き込みは返却をブロックしない**(完了後に非同期)。SQLite は WAL + busy_timeout。
- **クライアント切断**(ESC 中断)は正常系: `status='client_abort'`、上流へ abort 伝播。
- **429 / overloaded**: `status='rate_limited'` + quota_events 記録。gateway 自身はリトライしない(Claude Code に任せる)。**shifting 時の書き換え起因エラーのみ例外**: 書き換えたリクエストが 4xx で即死した場合、元モデルで 1 回だけ透過再試行(streaming は最初のイベント送出前のみ)し、`reason='degrade_guard'` を記録。
- **タイムアウト**: 上流接続 30s / 全体 10min。

## Hooks Companion

タスク境界(= 変速判断の起点)と repo 状態(= リプレイの基点)を通知する。**shifter がタスク文脈を知る唯一の情報源**。

### 設定(~/.claude/settings.json)

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "bun /path/to/model-routing/hooks/notify-task.ts" } ] }
    ]
  }
}
```

### hooks/notify-task.ts の仕様

1. stdin の hook 入力 JSON(`session_id`, `cwd`, `prompt` 等。**フィールド名は実装時に最新ドキュメントで確認**)を読む
2. `cwd` で `git rev-parse HEAD` / `git status --porcelain` / `git remote get-url origin`
3. `POST http://localhost:8484/internal/task-event`(タイムアウト 500ms)
4. **gateway が落ちていても即 exit 0**(fire-and-forget。開発体感を壊さない)

### gateway 側の受信処理

- task_events に記録 + ヒューリスティック分類を即時実行して `task_category` を埋める
- shifter のセッション状態(メモリ内)を更新: `sessionState[session_id] = { taskEventId, category, gear, since }`
- **hooks が来ないケース(未登録・失敗)でも動作は劣化のみ**: タスク文脈が不明な間、shifter はターン種別ルール(agent_step 降格)だけで動き、タスク単位の昇格はしない

## リクエストとセッションの紐付け

API リクエストには session_id が乗らないため、`(時刻近接, system_hash の連続性, プロンプト先頭の一致)` で直近の task_event に紐付ける(gateway 内のメモリ照合、確度が低ければ紐付けない)。**変速判断は「紐付け失敗 = タスク文脈不明 = 昇格しない」に倒れる**ので、誤紐付けの実害は限定的。

## ロギング仕様

[02-data-model.md](02-data-model.md) の requests / task_events / shift_events / quota_events に記録。`/internal/stats` の集計項目:

- リクエスト数・エラー率(status 別)
- 変速内訳(reason 別、gear_from→gear_to 別)
- **キャッシュヒット率**: cache_read_tokens / input_tokens(変速有効化前後の比較が M4 ゲート)
- 推定枠消費: モデル別トークン合計(ウィンドウ相当期間)

## 主要インターフェース

```ts
// packages/shared/src/types.ts
export type Tier = 'high' | 'mid' | 'low';

export interface RequestFeatures {
  modelRequested: string;
  tierRequested: Tier | null;     // models.yaml の match で正規化。null = 未知/never_touch
  isStreaming: boolean;
  messageCount: number;
  toolCount: number;
  hasToolResults: boolean;
  hasImages: boolean;
  systemHash: string | null;
  promptHash: string;
  approxInputTokens: number;
  lastUserText: string;
}

export interface SessionShiftState {
  taskEventId: string | null;
  category: TaskCategory | null;
  currentGear: Tier;              // このタスクで選択中のギア(sticky)
  demotedStreak: number;          // 連続降格ターン数(統計用)
}
```

## 起動と設定

```bash
bun run gateway    # PORT=8484、127.0.0.1 バインド
# 環境変数: PORT / MODEL_ROUTING_MODE=passthrough|shifting / MODEL_ROUTING_DISABLED
#           DATA_DIR(デフォルト ./data)/ UPSTREAM(テスト用モック差し替え)
```

## M0 完了条件の運用チェック

1. スパイクの結論が出ている(全面成立 / 降格のみ / 不成立 → 進路決定)
2. `ANTHROPIC_BASE_URL` 切り替えで 1 週間普段どおり開発し、エラー率 0%(client_abort 除く)・体感遅延なし
3. task_events に git_head 付きでタスクが記録されている
4. `/internal/stats` のキャッシュヒット率・モデル別トークンが妥当な値を示す(M4 の比較基準線になる)
