# Current Goal

Goal: Complete the planned model-routing implementation beyond M0, progressing milestone by milestone from M1 through M5 where feasible, with durable ledger updates, tests, docs, commits, and pushes after completed slices.
Owner: Codex
Started: 2026-07-06
Status: M2 in progress

## Current Milestone: M2 Replay, Judge, and Review UI

Success criteria:

- `packages/shifter` implements deterministic decision logic for agent_step, sticky task gear, and hold fallbacks.
- `datastore` includes `replay_runs`, `judgments`, and `human_reviews` via Drizzle migration and repositories/tests.
- `evals` can execute replay/judge stage skeletons idempotently against stored tasks/runs.
- Gateway has a safe seam for variant-specific shifter instances without changing passthrough default behavior.
- Review UI has the minimum queue/comparison storage path needed for human reviews.
- Repository verification passes before each pushed slice.

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
- [x] Add M2 datastore schema/repositories for replay/judge/review tables
- [x] Add `packages/shifter` decision engine with tests
- [x] Add eval replay skeleton and worktree lifecycle helpers
- [x] Add judge skeleton and pairwise prompt
- [x] Add minimal review-ui queue/comparison pages
- [ ] Integrate gateway variant seam without enabling production shifting
- [ ] Run verification, commit, and push M2 slice

## Notes

- 2026-07-06: M0 code completed and pushed. Operational 1-week M0 gate remains external/time-based.
- 2026-07-06: Review follow-ups fixed and pushed: Drizzle generated migration is now the db-init source, and Haiku demotion succeeds when stripping `output_config.effort`.
- 2026-07-06: M1 started. First implementation slice will add `eval_tasks` and evals runner scaffolding, then classify/sample commands.
- 2026-07-06: Added `eval_tasks`, eval config/prompt, `packages/evals` classify/sample/audit/report/smoke commands, dry-run sampling guard, and schedule guard seam. Targeted M1 tests passed before full verification.
- 2026-07-06: Verification passed: `bun test` (55 pass), `bun run lint`, `bun run evals -- report` and `estimate` against an empty temp DB, and `bun run smoke -- --gateway=http://127.0.0.1:18489` through a temporary gateway.
- 2026-07-06: M1 implementation slice committed and pushed as `3e90589`. M2 started with datastore replay/judge/review tables and shifter pure logic.
- 2026-07-06: Added M2 replay_runs/judgments/human_reviews schema and repositories, plus `packages/shifter` pure decision logic for tier normalization, agent_step demotion, task promote/demote, sticky hold, and overrides. Verification passed: `bun test` (61 pass) and `bun run lint`.
- 2026-07-06: Added replay stage skeleton, variant-to-model mapping, Agent SDK worktree executor seam, artifact writing under `data/runs`, quota event recording, and idempotent skip behavior. Targeted replay tests and empty-DB CLI replay passed.
- 2026-07-06: Added judge stage skeleton with pairwise-v1 prompt, schema-enforced Agent SDK judge output, position swapping, before-context extraction, idempotent judgment insertion, and tests. Review UI and gateway variant seam remain for M2.
- 2026-07-06: Added minimal Hono JSX Review UI with queue, blind compare, review POST storage, reveal page, keyboard submit script, and datastore review queue repositories/tests. Gateway variant seam remains for M2.
