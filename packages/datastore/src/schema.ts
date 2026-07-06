import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  cwd: text("cwd"),
  gitRemote: text("git_remote"),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  requestCount: integer("request_count").notNull().default(0),
});

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    createdAt: integer("created_at").notNull(),
    cwd: text("cwd").notNull(),
    gitHead: text("git_head"),
    gitDirty: integer("git_dirty").notNull(),
    promptText: text("prompt_text").notNull(),
    promptHash: text("prompt_hash").notNull(),
    taskCategory: text("task_category"),
    categorySource: text("category_source"),
    categoryConfidence: real("category_confidence"),
    selfContained: integer("self_contained"),
  },
  (table) => [
    index("idx_task_events_created").on(table.createdAt),
    index("idx_task_events_category").on(table.taskCategory, table.createdAt),
  ],
);

export const requests = sqliteTable(
  "requests",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").references(() => sessions.id),
    replayRunId: text("replay_run_id"),
    createdAt: integer("created_at").notNull(),
    modelRequested: text("model_requested").notNull(),
    modelServed: text("model_served").notNull(),
    isStreaming: integer("is_streaming").notNull(),
    messageCount: integer("message_count").notNull(),
    toolCount: integer("tool_count").notNull(),
    hasToolResults: integer("has_tool_results").notNull(),
    hasImages: integer("has_images").notNull(),
    systemHash: text("system_hash"),
    promptHash: text("prompt_hash").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    stopReason: text("stop_reason"),
    latencyMs: integer("latency_ms"),
    ttftMs: integer("ttft_ms"),
    errorMessage: text("error_message"),
    bodyPath: text("body_path").notNull(),
  },
  (table) => [
    index("idx_requests_created").on(table.createdAt),
    index("idx_requests_session").on(table.sessionId, table.createdAt),
    index("idx_requests_replay").on(table.replayRunId),
  ],
);

export const shiftEvents = sqliteTable("shift_events", {
  requestId: text("request_id")
    .primaryKey()
    .references(() => requests.id),
  createdAt: integer("created_at").notNull(),
  policyVersion: text("policy_version").notNull(),
  taskEventId: text("task_event_id").references(() => taskEvents.id),
  decidedCategory: text("decided_category"),
  gearFrom: text("gear_from").notNull(),
  gearTo: text("gear_to").notNull(),
  reason: text("reason").notNull(),
});

export const evalTasks = sqliteTable(
  "eval_tasks",
  {
    id: text("id").primaryKey(),
    taskEventId: text("task_event_id")
      .notNull()
      .references(() => taskEvents.id),
    batchId: text("batch_id").notNull(),
    createdAt: integer("created_at").notNull(),
    taskCategory: text("task_category").notNull(),
    repoPath: text("repo_path").notNull(),
    baseCommit: text("base_commit").notNull(),
    promptText: text("prompt_text").notNull(),
    verifyCommand: text("verify_command"),
    status: text("status").notNull().default("pending"),
  },
  (table) => [index("idx_eval_tasks_batch").on(table.batchId, table.status)],
);

export const replayRuns = sqliteTable(
  "replay_runs",
  {
    id: text("id").primaryKey(),
    evalTaskId: text("eval_task_id")
      .notNull()
      .references(() => evalTasks.id),
    variant: text("variant").notNull(),
    createdAt: integer("created_at").notNull(),
    status: text("status").notNull(),
    durationMs: integer("duration_ms"),
    turns: integer("turns"),
    totalInputTokens: integer("total_input_tokens"),
    totalOutputTokens: integer("total_output_tokens"),
    totalCacheRead: integer("total_cache_read"),
    diffPath: text("diff_path"),
    diffStat: text("diff_stat"),
    finalMessagePath: text("final_message_path"),
    verifyPassed: integer("verify_passed"),
    errorMessage: text("error_message"),
  },
  (table) => [uniqueIndex("idx_replay_runs_task").on(table.evalTaskId, table.variant)],
);

export const judgments = sqliteTable(
  "judgments",
  {
    id: text("id").primaryKey(),
    evalTaskId: text("eval_task_id")
      .notNull()
      .references(() => evalTasks.id),
    candidateRunId: text("candidate_run_id")
      .notNull()
      .references(() => replayRuns.id),
    baselineRunId: text("baseline_run_id")
      .notNull()
      .references(() => replayRuns.id),
    position: text("position").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: integer("created_at").notNull(),
    verdict: text("verdict").notNull(),
    scoresJson: text("scores_json"),
    rationale: text("rationale"),
  },
  (table) => [uniqueIndex("idx_judgments_task").on(table.evalTaskId, table.candidateRunId, table.position)],
);

export const humanReviews = sqliteTable(
  "human_reviews",
  {
    id: text("id").primaryKey(),
    evalTaskId: text("eval_task_id")
      .notNull()
      .references(() => evalTasks.id),
    candidateRunId: text("candidate_run_id")
      .notNull()
      .references(() => replayRuns.id),
    baselineRunId: text("baseline_run_id")
      .notNull()
      .references(() => replayRuns.id),
    createdAt: integer("created_at").notNull(),
    source: text("source").notNull().default("review_session"),
    verdict: text("verdict").notNull(),
    note: text("note"),
    reviewSeconds: integer("review_seconds"),
  },
  (table) => [index("idx_human_reviews_task").on(table.evalTaskId)],
);

export const tierProfiles = sqliteTable(
  "tier_profiles",
  {
    batchId: text("batch_id").notNull(),
    variant: text("variant").notNull(),
    taskCategory: text("task_category").notNull(),
    n: integer("n").notNull(),
    winRate: real("win_rate").notNull(),
    wilsonLow: real("wilson_low").notNull(),
    wilsonHigh: real("wilson_high").notNull(),
    verifyPassRate: real("verify_pass_rate"),
    avgTurns: real("avg_turns"),
    avgTotalTokens: real("avg_total_tokens"),
    avgDurationMs: real("avg_duration_ms"),
    errorRate: real("error_rate").notNull(),
    judgeHumanKappa: real("judge_human_kappa"),
  },
  (table) => [uniqueIndex("idx_tier_profiles_pk").on(table.batchId, table.variant, table.taskCategory)],
);

export const feedbackNotes = sqliteTable("feedback_notes", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  source: text("source").notNull(),
  text: text("text").notNull(),
  parsedJson: text("parsed_json"),
  status: text("status").notNull().default("pending"),
  resolution: text("resolution"),
});

export const quotaEvents = sqliteTable(
  "quota_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    kind: text("kind").notNull(),
    refId: text("ref_id"),
  },
  (table) => [index("idx_quota_window").on(table.createdAt)],
);
