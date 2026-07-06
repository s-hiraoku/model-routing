import { loadModelsConfig } from "@model-routing/shared";
import { loadShiftPolicy, type ShiftPolicy } from "@model-routing/shifter";
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
const shiftPolicyPath = Bun.env.SHIFT_POLICY ?? "config/shift-policy.yaml";
const shiftPolicyRef: { current: ShiftPolicy | null } = { current: await tryLoadShiftPolicy(shiftPolicyPath) };

async function tryLoadShiftPolicy(path: string): Promise<ShiftPolicy | null> {
  try {
    return await loadShiftPolicy(path);
  } catch (error) {
    console.warn(`[gateway] shift policy not loaded from ${path}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

process.on("SIGHUP", async () => {
  const next = await tryLoadShiftPolicy(shiftPolicyPath);
  shiftPolicyRef.current = next;
  console.info(`[gateway] shift policy reloaded: ${next?.version ?? "none"}`);
});

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: createGatewayApp({
    upstream,
    mode: requestedMode,
    models,
    shiftPolicyRef,
    variantPolicies: createReplayVariantPolicies(),
  }).fetch,
});

console.info(`[gateway] listening on http://127.0.0.1:${port}`);
console.info(`[gateway] upstream: ${upstream}`);
console.info(`[gateway] requested mode: ${requestedMode}`);
console.info(`[gateway] shift policy: ${shiftPolicyRef.current?.version ?? "none"}`);
