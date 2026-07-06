# Current Goal

Goal: Complete the planned model-routing implementation beyond M0, progressing milestone by milestone from M1 through M5 where feasible, with durable ledger updates, tests, docs, commits, and pushes after completed slices.
Owner: Codex
Started: 2026-07-06
Status: M1 in progress

## Current Milestone: M1 Classification, Sampling, and Log Exploration

Success criteria:

- `packages/evals` exists with an idempotent stage runner and CLI entrypoint.
- `datastore` includes `eval_tasks` via Drizzle schema and generated migration, with repositories/tests.
- Stage 1 classify can update task categories and self-contained flags, using heuristic logic locally and an Agent SDK seam for LLM classification.
- Stage 2 sample can create `eval_tasks` with dedup, dirty filtering, per-category limits, and quota estimate output.
- `audit-classify` CLI can display recent classified tasks for manual spot checks.
- `bun run smoke` provides the Agent SDK/gateway connectivity check seam.
- Docs/config/scripts are updated and repository verification passes.

## Plan

- [x] Finish M0 code and review follow-ups
- [x] Add M1 datastore schema/repositories for `eval_tasks`
- [x] Add `config/eval.yaml` and prompt files with Zod validation
- [x] Add `packages/evals` CLI runner and stage selection
- [x] Implement stage 1 classify
- [x] Implement stage 2 sample and estimate
- [x] Implement `audit-classify` and smoke command
- [x] Add M1 category/dirty/self-contained report
- [x] Update docs/README for M1 commands
- [x] Run verification, commit, and push

## Notes

- 2026-07-06: M0 code completed and pushed. Operational 1-week M0 gate remains external/time-based.
- 2026-07-06: Review follow-ups fixed and pushed: Drizzle generated migration is now the db-init source, and Haiku demotion succeeds when stripping `output_config.effort`.
- 2026-07-06: M1 started. First implementation slice will add `eval_tasks` and evals runner scaffolding, then classify/sample commands.
- 2026-07-06: Added `eval_tasks`, eval config/prompt, `packages/evals` classify/sample/audit/report/smoke commands, dry-run sampling guard, and schedule guard seam. Targeted M1 tests passed before full verification.
- 2026-07-06: Verification passed: `bun test` (55 pass), `bun run lint`, `bun run evals -- report` and `estimate` against an empty temp DB, and `bun run smoke -- --gateway=http://127.0.0.1:18489` through a temporary gateway.
