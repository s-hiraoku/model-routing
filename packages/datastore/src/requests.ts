import { Database } from "bun:sqlite";

export type RequestLogRow = {
  id: string;
  sessionId: string | null;
  replayRunId: string | null;
  createdAt: number;
  modelRequested: string;
  modelServed: string;
  isStreaming: boolean;
  messageCount: number;
  toolCount: number;
  hasToolResults: boolean;
  hasImages: boolean;
  systemHash: string | null;
  promptHash: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  status: string;
  httpStatus: number | null;
  stopReason: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  errorMessage: string | null;
  bodyPath: string;
};

export function insertRequestLog(dbPath: string, row: RequestLogRow): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT INTO requests (
        id, session_id, replay_run_id, created_at, model_requested, model_served,
        is_streaming, message_count, tool_count, has_tool_results, has_images,
        system_hash, prompt_hash, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, status, http_status, stop_reason, latency_ms, ttft_ms,
        error_message, body_path
      ) VALUES (
        $id, $sessionId, $replayRunId, $createdAt, $modelRequested, $modelServed,
        $isStreaming, $messageCount, $toolCount, $hasToolResults, $hasImages,
        $systemHash, $promptHash, $inputTokens, $outputTokens, $cacheReadTokens,
        $cacheWriteTokens, $status, $httpStatus, $stopReason, $latencyMs, $ttftMs,
        $errorMessage, $bodyPath
      )
      `,
    ).run({
      $id: row.id,
      $sessionId: row.sessionId,
      $replayRunId: row.replayRunId,
      $createdAt: row.createdAt,
      $modelRequested: row.modelRequested,
      $modelServed: row.modelServed,
      $isStreaming: row.isStreaming ? 1 : 0,
      $messageCount: row.messageCount,
      $toolCount: row.toolCount,
      $hasToolResults: row.hasToolResults ? 1 : 0,
      $hasImages: row.hasImages ? 1 : 0,
      $systemHash: row.systemHash,
      $promptHash: row.promptHash,
      $inputTokens: row.inputTokens,
      $outputTokens: row.outputTokens,
      $cacheReadTokens: row.cacheReadTokens,
      $cacheWriteTokens: row.cacheWriteTokens,
      $status: row.status,
      $httpStatus: row.httpStatus,
      $stopReason: row.stopReason,
      $latencyMs: row.latencyMs,
      $ttftMs: row.ttftMs,
      $errorMessage: row.errorMessage,
      $bodyPath: row.bodyPath,
    });
  } finally {
    db.close();
  }
}
