import { Database } from "bun:sqlite";
import { type TierProfileRow, upsertTierProfile } from "@model-routing/datastore";
import type { EvalConfig } from "@model-routing/shared";

type Verdict = "candidate_win" | "baseline_win" | "tie";

type PairRow = {
  task_category: string;
  variant: string;
  candidate_run_id: string;
  judge_verdicts: string | null;
  human_verdict: string | null;
};

type RunMetricRow = {
  task_category: string;
  variant: string;
  total_runs: number;
  error_runs: number;
  verify_known: number;
  verify_passed: number;
  avg_turns: number | null;
  avg_total_tokens: number | null;
  avg_duration_ms: number | null;
};

type RunMetrics = {
  errorRate: number;
  verifyPassRate: number | null;
  avgTurns: number | null;
  avgTotalTokens: number | null;
  avgDurationMs: number | null;
};

const verdictValues = new Set<Verdict>(["candidate_win", "baseline_win", "tie"]);

export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) {
    return { low: 0, high: 0 };
  }

  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denominator;

  return {
    low: Math.max(0, center - halfWidth),
    high: Math.min(1, center + halfWidth),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function normalizeVerdict(value: string | null): Verdict | null {
  return value && verdictValues.has(value as Verdict) ? (value as Verdict) : null;
}

function resolveJudgeVerdict(value: string | null): Verdict | null {
  if (!value) {
    return null;
  }

  const verdicts = value
    .split(",")
    .map((verdict) => normalizeVerdict(verdict))
    .filter((verdict): verdict is Verdict => verdict != null);
  if (verdicts.length === 0) {
    return null;
  }

  return new Set(verdicts).size === 1 ? verdicts[0] : "tie";
}

function verdictScore(verdict: Verdict): number {
  if (verdict === "candidate_win") {
    return 1;
  }

  return verdict === "tie" ? 0.5 : 0;
}

export function cohenKappa(pairs: Array<{ judge: Verdict; human: Verdict }>): number | null {
  if (pairs.length === 0) {
    return null;
  }

  const labels: Verdict[] = ["candidate_win", "baseline_win", "tie"];
  const observed = ratio(pairs.filter((pair) => pair.judge === pair.human).length, pairs.length);
  const expected = labels.reduce((sum, label) => {
    const judgeRate = ratio(pairs.filter((pair) => pair.judge === label).length, pairs.length);
    const humanRate = ratio(pairs.filter((pair) => pair.human === label).length, pairs.length);
    return sum + judgeRate * humanRate;
  }, 0);

  if (expected === 1) {
    return observed === 1 ? 1 : null;
  }

  return (observed - expected) / (1 - expected);
}

function pairRows(dbPath: string, batchId: string, baselineVariant: string): PairRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<PairRow, [string, string]>(
        `
        SELECT
          et.task_category,
          candidate.variant,
          candidate.id AS candidate_run_id,
          GROUP_CONCAT(j.verdict, ',') AS judge_verdicts,
          hr.verdict AS human_verdict
        FROM judgments j
        JOIN eval_tasks et ON et.id = j.eval_task_id
        JOIN replay_runs candidate ON candidate.id = j.candidate_run_id
        JOIN replay_runs baseline ON baseline.id = j.baseline_run_id
        LEFT JOIN human_reviews hr
          ON hr.id = (
            SELECT latest.id
            FROM human_reviews latest
            WHERE latest.eval_task_id = j.eval_task_id
              AND latest.candidate_run_id = j.candidate_run_id
              AND latest.baseline_run_id = j.baseline_run_id
            ORDER BY latest.created_at DESC, latest.id DESC
            LIMIT 1
          )
        WHERE et.batch_id = ?
          AND baseline.variant = ?
        GROUP BY et.id, candidate.id, baseline.id
        ORDER BY et.task_category, candidate.variant, candidate.id
        `,
      )
      .all(batchId, baselineVariant);
  } finally {
    db.close();
  }
}

function runMetrics(dbPath: string, batchId: string): Map<string, RunMetrics> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query<RunMetricRow, [string]>(
        `
        SELECT
          et.task_category,
          rr.variant,
          COUNT(*) AS total_runs,
          SUM(CASE WHEN rr.status = 'ok' THEN 0 ELSE 1 END) AS error_runs,
          SUM(CASE WHEN rr.verify_passed IS NULL THEN 0 ELSE 1 END) AS verify_known,
          SUM(CASE WHEN rr.verify_passed = 1 THEN 1 ELSE 0 END) AS verify_passed,
          AVG(rr.turns) AS avg_turns,
          AVG(CASE
            WHEN rr.total_input_tokens IS NULL
              AND rr.total_output_tokens IS NULL
              AND rr.total_cache_read IS NULL
            THEN NULL
            ELSE coalesce(rr.total_input_tokens, 0)
              + coalesce(rr.total_output_tokens, 0)
              + coalesce(rr.total_cache_read, 0)
          END) AS avg_total_tokens,
          AVG(rr.duration_ms) AS avg_duration_ms
        FROM replay_runs rr
        JOIN eval_tasks et ON et.id = rr.eval_task_id
        WHERE et.batch_id = ?
        GROUP BY et.task_category, rr.variant
        `,
      )
      .all(batchId);

    return new Map(
      rows.map((row) => [
        `${row.task_category}:${row.variant}`,
        {
          errorRate: ratio(row.error_runs, row.total_runs),
          verifyPassRate: row.verify_known === 0 ? null : ratio(row.verify_passed, row.verify_known),
          avgTurns: row.avg_turns,
          avgTotalTokens: row.avg_total_tokens,
          avgDurationMs: row.avg_duration_ms,
        },
      ]),
    );
  } finally {
    db.close();
  }
}

export function aggregateProfiles(args: { dbPath: string; batchId: string; config: EvalConfig }): TierProfileRow[] {
  const rows = pairRows(args.dbPath, args.batchId, args.config.replay.baseline);
  const metrics = runMetrics(args.dbPath, args.batchId);
  const byCategoryVariant = new Map<string, Array<{ verdict: Verdict; candidateRunId: string }>>();
  const kappaPairsByCategory = new Map<string, Array<{ judge: Verdict; human: Verdict }>>();

  for (const row of rows) {
    const judge = resolveJudgeVerdict(row.judge_verdicts);
    const human = normalizeVerdict(row.human_verdict);
    const finalVerdict = human ?? judge;
    if (!finalVerdict) {
      continue;
    }

    const key = `${row.task_category}:${row.variant}`;
    const group = byCategoryVariant.get(key) ?? [];
    group.push({ verdict: finalVerdict, candidateRunId: row.candidate_run_id });
    byCategoryVariant.set(key, group);

    if (judge && human) {
      const kappaPairs = kappaPairsByCategory.get(row.task_category) ?? [];
      kappaPairs.push({ judge, human });
      kappaPairsByCategory.set(row.task_category, kappaPairs);
    }
  }

  const kappaByCategory = new Map(
    [...kappaPairsByCategory.entries()].map(([category, pairs]) => [category, cohenKappa(pairs)]),
  );
  const profiles: TierProfileRow[] = [];

  for (const [key, group] of byCategoryVariant.entries()) {
    const [taskCategory, variant] = key.split(":", 2);
    const wins = group.reduce((sum, row) => sum + verdictScore(row.verdict), 0);
    const interval = wilsonInterval(wins, group.length);
    const runMetric = metrics.get(key);
    profiles.push({
      batchId: args.batchId,
      variant,
      taskCategory,
      n: group.length,
      winRate: wins / group.length,
      wilsonLow: interval.low,
      wilsonHigh: interval.high,
      verifyPassRate: runMetric?.verifyPassRate ?? null,
      avgTurns: runMetric?.avgTurns ?? null,
      avgTotalTokens: runMetric?.avgTotalTokens ?? null,
      avgDurationMs: runMetric?.avgDurationMs ?? null,
      errorRate: runMetric?.errorRate ?? 0,
      judgeHumanKappa: kappaByCategory.get(taskCategory) ?? null,
    });
  }

  return profiles.sort((a, b) => a.taskCategory.localeCompare(b.taskCategory) || a.variant.localeCompare(b.variant));
}

export function runAggregateStage(args: { dbPath: string; batchId: string; config: EvalConfig }): { profiles: number } {
  const profiles = aggregateProfiles(args);
  for (const profile of profiles) {
    upsertTierProfile(args.dbPath, profile);
  }

  return { profiles: profiles.length };
}
