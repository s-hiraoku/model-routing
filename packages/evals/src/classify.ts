import {
  type ClassificationCandidateRow,
  listTaskEventsForClassification,
  updateTaskClassification,
} from "@model-routing/datastore";
import { classifyHeuristic, type ModelsConfig, type TaskCategory } from "@model-routing/shared";

export type ClassificationResult = {
  category: TaskCategory;
  confidence: number;
  selfContained: boolean;
  reason: string;
};

export type LlmClassifier = (candidate: ClassificationCandidateRow) => Promise<ClassificationResult>;

const taskCategories = new Set<TaskCategory>([
  "plan",
  "debug",
  "code_gen",
  "code_edit",
  "review",
  "test",
  "docs",
  "unknown",
]);

function isTaskCategory(value: string): value is TaskCategory {
  return taskCategories.has(value as TaskCategory);
}

export function isLikelySelfContained(promptText: string): boolean {
  return !/(この流れ|さっき|先ほど|前の|それ|あれ|続き|push|deploy|デプロイ|本番反映|リリースして)/i.test(promptText);
}

export function classifyLocally(promptText: string): ClassificationResult {
  const heuristic = classifyHeuristic(promptText);
  return {
    category: heuristic.category,
    confidence: heuristic.confidence,
    selfContained: isLikelySelfContained(promptText),
    reason: heuristic.category === "unknown" ? "no heuristic matched" : "heuristic match",
  };
}

export function normalizeClassification(value: unknown): ClassificationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("classification result must be a JSON object");
  }

  const result = value as Record<string, unknown>;
  const category = typeof result.category === "string" && isTaskCategory(result.category) ? result.category : "unknown";
  const confidence = typeof result.confidence === "number" ? Math.max(0, Math.min(1, result.confidence)) : 0;
  const selfContained = typeof result.self_contained === "boolean" ? result.self_contained : false;
  const reason = typeof result.reason === "string" ? result.reason : "";

  return {
    category: confidence < 0.6 ? "unknown" : category,
    confidence,
    selfContained,
    reason,
  };
}

export async function createAgentSdkClassifier(args: {
  model: string;
  gatewayBaseUrl?: string;
  promptTemplate: string;
}): Promise<LlmClassifier> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  return async (candidate) => {
    const prompt = [
      args.promptTemplate,
      "",
      "# Project",
      candidate.cwd,
      "",
      "# User prompt",
      candidate.promptText.slice(0, 4000),
    ].join("\n");

    const outputSchema = {
      type: "object",
      properties: {
        category: { type: "string", enum: [...taskCategories] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        self_contained: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["category", "confidence", "self_contained", "reason"],
      additionalProperties: false,
    };

    let text = "";
    for await (const message of query({
      prompt,
      options: {
        model: args.model,
        cwd: candidate.cwd,
        permissionMode: "default",
        maxTurns: 1,
        outputFormat: { type: "json_schema", schema: outputSchema },
        env: {
          ...Bun.env,
          ...(args.gatewayBaseUrl ? { ANTHROPIC_BASE_URL: args.gatewayBaseUrl } : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: "model-routing-evals",
        },
      },
    })) {
      const maybeResult = message as { type?: string; result?: unknown; message?: unknown };
      if (maybeResult.type === "result" && typeof maybeResult.result === "string") {
        text += maybeResult.result;
      }
    }

    return normalizeClassification(JSON.parse(text));
  };
}

export async function classifyTasks(args: {
  dbPath: string;
  limit: number;
  llmClassifier?: LlmClassifier;
}): Promise<{ scanned: number; updated: number; llmUsed: number }> {
  const candidates = listTaskEventsForClassification(args.dbPath, args.limit);
  let updated = 0;
  let llmUsed = 0;

  for (const candidate of candidates) {
    let result = classifyLocally(candidate.promptText);
    let source = "heuristic";
    if ((result.category === "unknown" || result.confidence < 0.8) && args.llmClassifier) {
      result = await args.llmClassifier(candidate);
      source = "llm";
      llmUsed += 1;
    }

    updateTaskClassification(args.dbPath, {
      id: candidate.id,
      taskCategory: result.category,
      categorySource: source,
      categoryConfidence: result.confidence,
      selfContained: result.selfContained,
    });
    updated += 1;
  }

  return { scanned: candidates.length, updated, llmUsed };
}

export function lowTierModel(models: ModelsConfig): string {
  return models.tiers.low.model;
}
