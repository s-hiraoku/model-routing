# Current Goal

Goal: Complete the planned model-routing implementation beyond M0, progressing milestone by milestone from M1 through M5 where feasible, with durable ledger updates, tests, docs, commits, and pushes after completed slices.
Owner: Codex
Started: 2026-07-06
Status: M5 in progress

## Current Milestone: M5 Self-Evolution Foundations

Success criteria:

- `config/feedback.yaml` is validated and exposes attention budget / notification defaults.
- Nightly reporting summarizes correction-like prompts, unknown models, and shifted errors.
- Policy rollback CLI restores a versioned policy file safely.
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
- [x] Integrate gateway variant seam without enabling production shifting
- [x] Run verification, commit, and push M2 slice
- [x] Add aggregate stage and Wilson CI helpers
- [x] Add Markdown report and policy generation stage
- [x] Add policy changelog persistence or generated changelog output
- [x] Update docs/README for M3 commands
- [x] Run verification, commit, and push M3 slice
- [x] Integrate production shifting mode with loaded policy
- [x] Add shifted 4xx transparent retry and degrade_guard logging
- [x] Add SIGHUP policy reload in gateway main
- [x] Add rollout/stats polish for cache comparison and operational notes
- [x] Run verification, commit, and push M4 slice
- [x] Add feedback config loader
- [x] Add nightly monitoring report
- [x] Add policy rollback CLI
- [x] Add `feedback_notes` schema and repository
- [x] Add feedback CLI add/list
- [x] Add `skills/model-feedback/SKILL.md`
- [x] Add `preference_queue` schema and feedback stage enqueue
- [x] Add Review UI push queue and answered preference tracking
- [x] Expire stale preference queue items during feedback stage
- [x] Run verification, commit, and push current M5 slices
- [x] Add feedback proposal persistence and local interpretation stage
- [ ] Implement feedback proposal approval UI and policy application
- [ ] Implement auto-suspend / rollback changelog loop

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
- 2026-07-06: Added gateway replay variant seam with `/internal/replay-begin` and `/internal/replay-end`, localhost-only `X-MR-Variant` handling, `mid+demote` agent-step demotion through shifter, request replay_run_id logging, and shift_events insertion.
- 2026-07-06: M2 implementation slices pushed through `f1585cf`. Verification passed: `bun test` (70 pass), `bun run lint`, and empty-DB replay CLI. M2 operational gate remains external: run a real batch, review at least 20 pairs, and check 4-variant completion plus human-judge κ. M3 implementation started.
- 2026-07-06: Added M3 aggregate stage with Wilson CI, human review overrides, judge-human κ, `tier_profiles` schema/repository, plus report and conservative shift-policy generation from thresholds while preserving overrides.
- 2026-07-06: M3 implementation slice pushed as `079d88c`. Verification passed: `bun test` (75 pass), `bun run lint`, and empty-DB aggregate/report CLI. M3 operational gate remains external: accumulate real batches and inspect generated policy conclusions.
- 2026-07-06: Added M4 production shifting integration behind `MODEL_ROUTING_MODE=shifting`, `SHIFT_POLICY` loading with SIGHUP reload, policy-driven model rewrite, and shifted 4xx original-body retry recorded as `degrade_guard`.
- 2026-07-06: Extended gateway stats with shifted vs unshifted cache hit rates for rollout comparison.
- 2026-07-06: M4 implementation slices pushed through `a6bef4e`. Verification passed: `bun test` (77 pass) and `bun run lint`. M4 operational gate remains external: run shifting for staged windows and compare quality/error/cache metrics.
- 2026-07-06: Added M5 foundations: feedback config loader, nightly Markdown report for correction-like tasks / unknown models / shifted errors, and policy rollback CLI.
- 2026-07-06: Added `feedback_notes` persistence and `bun run feedback -- add/list` so freeform human feedback can be captured before stage 7 interpretation is wired in.
- 2026-07-06: Added `skills/model-feedback/SKILL.md` as the thin wrapper for storing freeform feedback with source `model-feedback`.
- 2026-07-06: Added `preference_queue` persistence and `bun run evals -- run --stage feedback` to enqueue blind A/B preference prompts within the weekly attention budget.
- 2026-07-06: Added Review UI `/push` flow so preference prompts can be answered as `human_reviews(source='push')` and linked back to `preference_queue`.
- 2026-07-06: Added preference queue expiration during feedback stage so stale prompts release weekly attention budget.
- 2026-07-08: Added `feedback_proposals` persistence and local feedback-note interpretation in `evals --stage feedback`, producing reviewable policy/evaluation follow-up proposals before LLM interpretation is wired in.
