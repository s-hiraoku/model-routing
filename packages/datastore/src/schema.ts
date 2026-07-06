import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
