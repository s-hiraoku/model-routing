import {
  countEvalTasksByBatch,
  insertEvalTask,
  listSampleCandidates,
  type SampleCandidateRow,
} from "@model-routing/datastore";
import { type EvalConfig, uuidv7 } from "@model-routing/shared";

const priorityCategories = ["plan", "debug", "test", "docs"];

export type SampleEstimate = {
  tasks: number;
  replayRuns: number;
  judgeRuns: number;
  totalRuns: number;
  estimatedWindows: number;
};

export function estimateRuns(taskCount: number, variantCount: number, evalRunsPerWindow: number): SampleEstimate {
  const replayRuns = taskCount * variantCount;
  const judgeRuns = taskCount * 3 * 2;
  const totalRuns = replayRuns + judgeRuns;

  return {
    tasks: taskCount,
    replayRuns,
    judgeRuns,
    totalRuns,
    estimatedWindows: Math.ceil(totalRuns / evalRunsPerWindow),
  };
}

function categoryRank(category: string): number {
  const index = priorityCategories.indexOf(category);
  return index === -1 ? priorityCategories.length : index;
}

export function selectSampleCandidates(candidates: SampleCandidateRow[], config: EvalConfig): SampleCandidateRow[] {
  const filtered = candidates.filter((candidate) => {
    if (candidate.promptText.length > config.sampling.max_task_prompt_chars) {
      return false;
    }

    if (config.sampling.exclude_repos.includes(candidate.repoPath)) {
      return false;
    }

    return true;
  });

  const grouped = new Map<string, SampleCandidateRow[]>();
  for (const candidate of filtered) {
    const group = grouped.get(candidate.taskCategory) ?? [];
    group.push(candidate);
    grouped.set(candidate.taskCategory, group);
  }

  const selected: SampleCandidateRow[] = [];
  const categories = [...grouped.keys()].sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b));

  for (const category of categories) {
    const group = grouped.get(category) ?? [];
    while (group.length > 0 && selected.length < config.sampling.per_batch) {
      if (
        selected.filter((candidate) => candidate.taskCategory === category).length >=
          config.sampling.per_category_min &&
        categories.some((other) => other !== category && (grouped.get(other)?.length ?? 0) > 0)
      ) {
        break;
      }

      selected.push(group.shift() as SampleCandidateRow);
    }
  }

  while (selected.length < config.sampling.per_batch) {
    const nextCategory = categories.find((category) => (grouped.get(category)?.length ?? 0) > 0);
    if (!nextCategory) {
      break;
    }

    selected.push((grouped.get(nextCategory) as SampleCandidateRow[]).shift() as SampleCandidateRow);
  }

  return selected;
}

export function sampleTasks(args: {
  dbPath: string;
  batchId: string;
  config: EvalConfig;
  evalRunsPerWindow: number;
  dryRun?: boolean;
  now?: number;
}): {
  inserted: number;
  alreadyPresent: number;
  estimate: SampleEstimate;
} {
  const alreadyPresent = countEvalTasksByBatch(args.dbPath, args.batchId);
  if (alreadyPresent > 0) {
    return {
      inserted: 0,
      alreadyPresent,
      estimate: estimateRuns(alreadyPresent, args.config.replay.variants.length, args.evalRunsPerWindow),
    };
  }

  const now = args.now ?? Date.now();
  const since = now - args.config.sampling.dedup_window_days * 24 * 60 * 60 * 1000;
  const candidates = listSampleCandidates(args.dbPath, {
    since,
    excludeRepos: args.config.sampling.exclude_repos,
    limit: args.config.sampling.per_batch * 4,
  });
  const selected = selectSampleCandidates(candidates, args.config);

  if (!args.dryRun) {
    for (const candidate of selected) {
      insertEvalTask(args.dbPath, {
        id: uuidv7(),
        taskEventId: candidate.taskEventId,
        batchId: args.batchId,
        createdAt: now,
        taskCategory: candidate.taskCategory,
        repoPath: candidate.repoPath,
        baseCommit: candidate.baseCommit,
        promptText: candidate.promptText,
        verifyCommand: args.config.replay.verify_commands[candidate.repoPath] ?? null,
      });
    }
  }

  return {
    inserted: args.dryRun ? 0 : selected.length,
    alreadyPresent: 0,
    estimate: estimateRuns(selected.length, args.config.replay.variants.length, args.evalRunsPerWindow),
  };
}
