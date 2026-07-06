import { describe, expect, test } from "bun:test";
import type { SampleCandidateRow } from "@model-routing/datastore";
import type { EvalConfig } from "@model-routing/shared";
import { estimateRuns, selectSampleCandidates } from "./sample";

const config: EvalConfig = {
  sampling: {
    per_batch: 4,
    per_category_min: 1,
    self_contained_only: true,
    max_task_prompt_chars: 100,
    dedup_window_days: 30,
    exclude_repos: ["/excluded"],
  },
  replay: {
    variants: [{ id: "high" }, { id: "mid" }, { id: "low" }, { id: "mid+demote" }],
    baseline: "mid",
    isolation: "worktree",
    timeout_minutes: 15,
    concurrency: 1,
    verify_commands: {},
    setup_commands: {},
  },
  judge: { primary: "high", position_swap: true },
  human_review: { sample_rate: 0.25, low_margin_always: true },
  schedule: { allowed_hours: [0], pause_on_rate_limit: true },
  policy_generation: {
    demote_min_n: 10,
    demote_wilson_low: 0.4,
    promote_min_n: 10,
    promote_wilson_low: 0.55,
    min_kappa: 0.6,
  },
};

function candidate(id: string, category: string, repoPath = "/repo"): SampleCandidateRow {
  return {
    taskEventId: id,
    createdAt: Number(id),
    taskCategory: category,
    repoPath,
    baseCommit: "abc",
    promptText: `prompt ${id}`,
    promptHash: `hash-${id}`,
    sessionId: `session-${id}`,
  };
}

describe("selectSampleCandidates", () => {
  test("prioritizes hypothesis categories and filters long/excluded prompts", () => {
    const selected = selectSampleCandidates(
      [
        candidate("1", "code_edit"),
        candidate("2", "docs"),
        candidate("3", "debug"),
        { ...candidate("4", "test"), promptText: "x".repeat(101) },
        candidate("5", "plan", "/excluded"),
        candidate("6", "test"),
      ],
      config,
    );

    expect(selected.map((row) => row.taskEventId)).toEqual(["3", "6", "2", "1"]);
  });
});

describe("estimateRuns", () => {
  test("counts replay and pairwise judge runs", () => {
    expect(estimateRuns(10, 4, 20)).toEqual({
      tasks: 10,
      replayRuns: 40,
      judgeRuns: 60,
      totalRuns: 100,
      estimatedWindows: 5,
    });
  });
});
