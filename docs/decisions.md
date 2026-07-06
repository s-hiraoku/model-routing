# Decisions

## 2026-07-06: OAuth model rewrite spike

Status: pending

Goal: confirm whether Claude Code subscription OAuth traffic still succeeds when the local gateway rewrites the top-level `/v1/messages` `model` field.

Commands:

```bash
REWRITE_MODEL="<target-model-id>" bun run spike:rewrite
ANTHROPIC_BASE_URL="http://127.0.0.1:8484" claude -p "1+1は?"
```

Optional environment variables:

- `PORT`: local proxy port. Default: `8484`.
- `UPSTREAM`: upstream origin. Default: `https://api.anthropic.com`.

Checks:

- [ ] Sonnet to Haiku rewrite returns 200.
- [ ] Sonnet to Opus rewrite returns 200.
- [ ] Streaming responses complete normally.
- [ ] Claude Code display and a follow-up turn still work.

Outcome:

- Pending.

Notes:

- The spike proxy is intentionally minimal and lives at `scripts/spike-rewrite.ts`.
- It binds only to `127.0.0.1`, preserves request headers except for upstream `host` and recalculated body length, and rewrites only the top-level `model` field for `POST /v1/messages`.
