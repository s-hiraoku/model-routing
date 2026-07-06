export async function runAgentSdkSmoke(args: {
  model: string;
  gatewayBaseUrl?: string;
  cwd?: string;
}): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  let text = "";

  for await (const message of query({
    prompt: "Reply with exactly: ok",
    options: {
      model: args.model,
      cwd: args.cwd ?? process.cwd(),
      permissionMode: "default",
      maxTurns: 1,
      env: {
        ...Bun.env,
        ...(args.gatewayBaseUrl ? { ANTHROPIC_BASE_URL: args.gatewayBaseUrl } : {}),
        CLAUDE_AGENT_SDK_CLIENT_APP: "model-routing-evals-smoke",
      },
    },
  })) {
    const maybeResult = message as { type?: string; result?: unknown };
    if (maybeResult.type === "result" && typeof maybeResult.result === "string") {
      text += maybeResult.result;
    }
  }

  return text.trim();
}
