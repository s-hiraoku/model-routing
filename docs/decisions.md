# Decisions

## 2026-07-06: OAuth model rewrite spike

Status: partial success

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

- [x] Passthrough control: `REWRITE_MODEL` unset and `claude -p` completes normally, including streaming.
- [ ] Current requested model to Haiku rewrite returns 200.
- [x] Current requested model to Opus rewrite returns 200.
- [x] Streaming responses complete normally for passthrough and Opus rewrite.
- [x] Claude Code display works for passthrough and Opus rewrite.

Outcome:

- Current Claude Code 2.1.201 requested `claude-fable-5`, not a Sonnet model ID, during this spike.
- Passthrough via the spike proxy completed normally. The response model logged by the proxy was `claude-fable-5`.
- Rewriting `claude-fable-5` to `claude-opus-4-8` completed normally. The response model logged by the proxy was `claude-opus-4-8`.
- Rewriting `claude-fable-5` to `claude-haiku-4-5-20251001` failed with provider status 400: `This model does not support the effort parameter.`
- Conclusion: subscription OAuth traffic can tolerate at least some model rewrites, including Opus promotion. Pure model-only Haiku demotion is not currently viable for Claude Code traffic because the request includes an `effort` parameter incompatible with Haiku.
- Route decision: continue with M0 passthrough gateway/logging and promotion-capable evaluation plumbing, but do not implement production Haiku demotion until the design is updated to handle model-specific incompatible request fields or a compatible low-tier model is identified.

Notes:

- The spike proxy is intentionally minimal and lives at `scripts/spike-rewrite.ts`.
- It binds only to `127.0.0.1`, preserves request headers except for upstream `host` and recalculated body length, and rewrites only the top-level `model` field for `POST /v1/messages`.
- A first run exposed a proxy false-negative risk: Bun returned a decoded response body while preserving compression headers, causing Claude Code `Decompression error: ZlibError`. The spike proxy now removes `content-encoding`, `content-length`, and `transfer-encoding` from client responses.
- The proxy now logs `/v1/messages` response model values from JSON or SSE `message_start` events without logging response bodies.
