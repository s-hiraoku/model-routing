#!/usr/bin/env bash
# M0 運用ゲート開始セットアップ(冪等)。ユーザー自身が実行すること:
#   bash scripts/setup-m0-gate.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GATEWAY_URL="http://localhost:8484"

echo "== 1/4 gateway 起動確認 =="
if curl -sf "${GATEWAY_URL}/internal/healthz" >/dev/null 2>&1; then
  echo "gateway: 起動済み"
else
  echo "gateway: 起動します(nohup。停止は pkill -f 'gateway/src/main.ts')"
  mkdir -p "${REPO}/data"
  (cd "${REPO}" && nohup bun packages/gateway/src/main.ts >> data/gateway.log 2>&1 &)
  sleep 2
  curl -sf "${GATEWAY_URL}/internal/healthz" >/dev/null || { echo "起動失敗。data/gateway.log を確認"; exit 1; }
  echo "gateway: 起動しました"
fi

echo "== 2/4 ~/.zshrc に ANTHROPIC_BASE_URL を設定 =="
if grep -q 'ANTHROPIC_BASE_URL' ~/.zshrc 2>/dev/null; then
  echo "zshrc: 設定済み(スキップ)"
else
  printf '\n# model-routing gateway (この行を消せば素の接続に戻る)\nexport ANTHROPIC_BASE_URL="%s"\n' "${GATEWAY_URL}" >> ~/.zshrc
  echo "zshrc: 追記しました(新しいシェルから有効)"
fi

echo "== 3/4 Claude Code hooks に notify-task を登録 =="
python3 - "$REPO" <<'PY'
import json, sys, os, shutil
repo = sys.argv[1]
path = os.path.expanduser("~/.claude/settings.json")
cmd = f"bun {repo}/hooks/notify-task.ts"
with open(path) as f:
    settings = json.load(f)
hooks = settings.setdefault("hooks", {}).setdefault("UserPromptSubmit", [])
if any(cmd in h.get("command", "") for entry in hooks for h in entry.get("hooks", [])):
    print("hooks: 登録済み(スキップ)")
else:
    shutil.copy(path, path + ".bak-model-routing")
    hooks.append({"hooks": [{"type": "command", "command": cmd, "timeout": 5}]})
    with open(path, "w") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
    print(f"hooks: 追記しました(バックアップ: {path}.bak-model-routing)")
PY

echo "== 4/4 疎通確認(claude -p を gateway 経由で 1 回実行)=="
if ANTHROPIC_BASE_URL="${GATEWAY_URL}" claude -p "1+1は? 数字のみで答えて。" >/dev/null 2>&1; then
  echo "疎通: OK"
  curl -s "${GATEWAY_URL}/internal/stats" | head -c 200; echo
else
  echo "疎通: 失敗。ANTHROPIC_BASE_URL を外して claude が動くか確認してください"
  exit 1
fi

cat <<'DONE'

セットアップ完了。以後は新しいターミナル/Claude Code セッションから
自動的に gateway 経由になります。1 週間後のゲート判定:
  curl -s http://localhost:8484/internal/stats | bun run log-explorer
緊急時: ~/.zshrc の ANTHROPIC_BASE_URL 行を削除(または unset)するだけ。
DONE
