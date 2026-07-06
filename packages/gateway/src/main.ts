import { loadModelsConfig } from "@model-routing/shared";
import { createGatewayApp, createReplayVariantPolicies } from "./app";

const DEFAULT_PORT = 8484;
const DEFAULT_UPSTREAM = "https://api.anthropic.com";

function envNumber(name: string, fallback: number): number {
  const value = Bun.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

const port = envNumber("PORT", DEFAULT_PORT);
const upstream = Bun.env.UPSTREAM ?? DEFAULT_UPSTREAM;
const requestedMode = Bun.env.MODEL_ROUTING_MODE === "shifting" ? "shifting" : "passthrough";
const models = await loadModelsConfig(Bun.env.MODELS_CONFIG ?? "config/models.yaml");

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: createGatewayApp({
    upstream,
    mode: requestedMode,
    models,
    variantPolicies: createReplayVariantPolicies(),
  }).fetch,
});

console.info(`[gateway] listening on http://127.0.0.1:${port}`);
console.info(`[gateway] upstream: ${upstream}`);
console.info(`[gateway] requested mode: ${requestedMode}`);
