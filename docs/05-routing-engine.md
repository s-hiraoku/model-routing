# 05. 変速機(Shifter)仕様

gateway に組み込まれる変速エンジン。評価パイプラインが生成した `shift-policy.yaml` を根拠に、リクエストごとのギア(tier)を決定する。

## 設計原則

1. **確信がないときは触らない。** unknown カテゴリ、κ 不足、タスク文脈不明、判定グレーはすべて素通し。変速は「確実に得する場合だけ介入する」オプトイン動作。
2. **同期・高速・決定的。** LLM 呼び出し・DB 読み禁止。メモリ内のポリシー + セッション状態のみで 1ms 未満。
3. **昇格と降格で閾値を非対称に。** 降格は品質リスクがあるので保守的に(「ほぼ負けない」証拠が必要)。昇格は枠リスクがあるので「明確に勝つ」証拠が必要。
4. **タスク境界で変速し、タスク内では粘る(sticky)。** ターンごとのフリップフロップはプロンプトキャッシュを分断して枠を余計に食う。例外は agent_step 降格(連続区間でまとめて降ろす)。
5. **すべての介入を記録する**(shift_events)。「なぜこのギアだったか」を必ず説明できる。

## ポリシーファイル

`config/shift-policy.yaml`。**aggregator が生成**、gateway は起動時 + SIGHUP でリロード。手編集は `overrides` のみ。

```yaml
version: "2026-W28.1"
generated_at: "2026-07-13T09:00:00+09:00"
generated_from_batch: "2026-W28"

demote:                              # 降格ルール
  agent_step:
    enabled: true                    # 中間ターンを low へ
    to: low
    min_consecutive: 2               # 2 ターン以上続く見込みの区間のみ降格(キャッシュ分断対策)
    evidence: { variant: "mid+demote", win_rate: 0.49, wilson_low: 0.41, n: 18, kappa: 0.68,
                net_token_delta: "-31%" }
  categories:                        # タスク丸ごと降格(カテゴリ単位)
    docs:
      to: low
      evidence: { variant: "low", win_rate: 0.47, wilson_low: 0.40, n: 14, kappa: 0.71 }

promote:                             # 昇格ルール(カテゴリ単位)
  categories:
    plan:
      to: high
      evidence: { variant: "high", win_rate: 0.68, wilson_low: 0.56, n: 15, kappa: 0.74 }
    debug:
      to: high
      evidence: { variant: "high", win_rate: 0.64, wilson_low: 0.55, n: 12, kappa: 0.66 }

governor:                            # 枠ガバナー
  quota_guard: true                  # 枠逼迫時は昇格を停止
  window_burn_threshold: 0.7         # 現ウィンドウの推定消費が 70% 超なら昇格禁止
  degrade_error_rate: 0.3            # 書き換えリクエストの直近 20 件エラー率がこれを超えたら
  degrade_pause_minutes: 15          #   該当ルールを 15 分停止

overrides:                           # 手動上書き。再生成時もマージ保持
  review:
    action: none                     # none = このカテゴリには絶対に触らない
    note: "レビューはデフォルトのまま使いたい"
```

### ポリシー生成ルール(aggregator 内)

`eval.yaml` の `policy_generation` 閾値を使用:

```
降格エントリ生成(カテゴリ or agent_step):
  - wilson_low > 0.40(baseline にほぼ負けない)
  - かつ avg_total_tokens が baseline 比で正味減(ターン増で相殺されていない)
  - かつ n >= 10、カテゴリ κ >= 0.6、error_rate < 10%

昇格エントリ生成(カテゴリ):
  - wilson_low > 0.55(明確に勝つ)
  - かつ n >= 10、カテゴリ κ >= 0.6

どちらも満たさない → エントリなし(= そのカテゴリは触らない)
```

### 変更の統治(自己進化の暴走防止。詳細は 07)

ポリシー再生成は毎バッチ走るが、無制限には変えない:

- **変更予算**: 1 サイクルのルール変更は `max_rule_changes_per_batch`(デフォルト 2)件まで。優先順位: 人間フィードバック由来 > 自動ロールバックの復帰判定 > 新規証拠
- **全変更を policy_changelog に記録**(origin・evidence 付き)し、3 行以内のサマリを通知(返答不要)
- **自動ロールバック**: 夜間ジョブの劣化判定(訂正プロンプト率の跳ね上がり等)でルールをサスペンド。復帰には次バッチでの再検証が必要
- **人間フィードバック由来の変更は必ず人間の承認を経る**(LLM が変更案に翻訳 → review-ui で承認)
- `overrides` は生成ロジック・自動変更のすべてに優先(絶対的拒否権)
- 旧バージョンのポリシーは `keep_policy_versions` 世代保持し、`bun run policy -- rollback <version>` で即時巻き戻し可能

## 判断フロー(gateway 内、同期)

```
decide(features: RequestFeatures, state: SessionShiftState): ShiftDecision
 │
 ├─ 0. キルスイッチ / passthrough モード → hold
 ├─ 1. tierRequested が null(未知モデル)or never_touch にマッチ → hold
 │      ※ Claude Code が雑務用に明示指定した haiku には絶対に介入しない
 ├─ 2. agent_step 判定(ターン種別。タスク文脈がなくても動く):
 │      hasToolResults && lastUserText.trim().length < 40 && toolCount > 0
 │      && approxInputTokens < 100_000
 │      └─ demote.agent_step.enabled → gear = low (reason: demote_agent_step)
 │           ※ min_consecutive 対応: 直前ターンも agent_step だった場合のみ降格
 │             (state.demotedStreak で判定。初回 agent_step は素通しして様子見)
 ├─ 3. タスク単位ギア(state.currentGear が決定済みならそれに従う = sticky):
 │      state.category が promote/demote.categories にあり、かつタスク先頭ターン
 │      └─ governor 通過なら currentGear を更新 (reason: promote_task / demote_task)
 ├─ 4. governor チェック(昇格のみ):
 │      直近ウィンドウの推定消費 > threshold → 昇格取り消し (reason: quota_governor)
 │      該当ルールがデグレード停止中 → hold (reason: degrade_guard)
 └─ 5. 上記いずれも該当なし → hold(素通し)
```

### タスク境界とセッション状態

- hooks の task-event 受信でセッション状態をリセットし、カテゴリを確定 → 次のリクエストがタスク先頭ターン
- **hooks が来ない/紐付け不能なら昇格・カテゴリ降格はしない**(agent_step 降格のみ動く)。劣化はするが誤動作はしない
- セッション状態はメモリ内のみ(gateway 再起動でリセット。次のタスク境界から再開)

### キャッシュ分断への配慮

- タスク内 sticky + `min_consecutive` により、モデル切り替え回数を最小化する
- それでも降格区間 ↔ 通常区間の往復でキャッシュミスは発生する。**正味で得かどうかは理屈でなく計測で判定**: M4 で降格有効化の前後 1 週間の `cache_read_tokens / input_tokens` とモデル別トークン合計を比較し、損 > 益なら `min_consecutive` を上げるか agent_step 降格を無効化する

## 監視と安全装置

- `GET /internal/stats` に変速内訳: reason 別件数、gear_from→gear_to 別件数、書き換えリクエストのエラー率、キャッシュヒット率(変速あり/なし比較)
- **自動デグレード**: ルール単位でエラー率監視(governor.degrade_*)。発動時は warn ログ + stats に表示
- ポリシーファイルが Zod 検証失敗 → 旧ポリシー維持、なければ全素通し
- `overrides.<category>.action: none` は最強(生成ポリシーより優先)

## 主要インターフェース

```ts
// packages/shifter/src/index.ts
export interface ShiftDecision {
  gear: Tier;                    // 適用ギア(hold なら tierRequested と同値)
  reason: 'demote_agent_step' | 'demote_task' | 'promote_task' | 'hold'
        | 'hold_sticky' | 'quota_governor' | 'degrade_guard';
  policyVersion: string | null;
}

export interface Shifter {
  decide(features: RequestFeatures, state: SessionShiftState): ShiftDecision;
  onTaskEvent(e: TaskEvent): void;          // セッション状態の更新
  onRequestResult(r: { gear: Tier; ok: boolean }): void;  // デグレード監視用
  reload(): Promise<void>;
}
```

variant 適用(評価リプレイ)は同じ Shifter を variant 別ポリシーで複数インスタンス化して実現する(`X-MR-Variant: mid+demote` → demote ルールのみ有効な Shifter が処理)。

## M4 ロールアウト手順

1. **降格から**(失敗しても品質劣化は 1 ターンで、次ターンにリカバーされやすい):
   `demote.agent_step` のみ有効化 → 3 日間 stats 監視(エラー率 < 1%、体感劣化なし)
2. キャッシュ計測: 有効化前後の 1 週間でキャッシュヒット率・モデル別トークンを比較 → 正味プラスを確認
3. カテゴリ降格(docs / test 等、ポリシーにあれば)を追加 → 3 日観察
4. **昇格を最後に**(枠を食う方向なので): plan / debug を有効化 → 1 週間で「Opus に上がった場面の成果に満足か」を体感確認
5. 問題が出たルールは overrides で即無効化(SIGHUP リロード、再起動不要)
