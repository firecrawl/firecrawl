import { config } from "../config";
import { agentConsumeFreeRequestIfLeft } from "../db/rpc";
import { logRequest } from "../services/logging/log_job";
import type { AgentRequest } from "../controllers/v2/types";
import { AGENT_REQUEST_CREDITS_SHARDS } from "./request-credits-store";

type LaunchAgentJobResult =
  | { ok: true; threadId?: string; threadTurn?: number }
  | { ok: false; status: number; text: string };

// Consumes a free request if one is left, logs the request and hands the job
// to the agent service. Shared by POST /v2/agent and the Slack integration so
// both bill and record agent runs the same way.
export async function launchAgentJob(params: {
  agentId: string;
  teamId: string;
  apiKey: string;
  apiKeyId: number | null;
  externalRequestId?: string | null;
  request: AgentRequest;
}): Promise<LaunchAgentJobResult> {
  const { agentId, teamId, request } = params;

  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  // If maxCredits > 2500, skip free request consumption — this is always a paid request
  const highCreditRequest =
    request.maxCredits !== undefined && request.maxCredits > 2500;

  let freeRequest: any;

  if (config.USE_DB_AUTHENTICATION && !highCreditRequest) {
    freeRequest = await agentConsumeFreeRequestIfLeft(teamId);
  }

  const isFreeRequest = highCreditRequest
    ? false
    : config.USE_DB_AUTHENTICATION
      ? !!freeRequest?.[0]?.consumed
      : true;

  await logRequest({
    id: agentId,
    kind: "agent",
    api_version: "v2",
    external_request_id: params.externalRequestId ?? null,
    team_id: teamId,
    origin: request.origin ?? "api",
    integration: request.integration,
    target_hint: request.urls?.[0] ?? request.prompt ?? "",
    zeroDataRetention: false, // not supported for agent
    api_key_id: params.apiKeyId,
    creditsShards: AGENT_REQUEST_CREDITS_SHARDS,
  });

  const passthrough = await fetch(
    config.EXTRACT_V3_BETA_URL + "/internal/extracts",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
      },
      body: JSON.stringify({
        id: agentId,
        urls: request.urls,
        schema: request.schema,
        prompt: request.prompt,
        apiKey: params.apiKey,
        apiKeyId: params.apiKeyId ?? undefined,
        teamId,
        isFreeRequest,
        maxCredits: request.maxCredits ?? undefined,
        strictConstrainToURLs: request.strictConstrainToURLs ?? undefined,
        webhook: request.webhook ?? undefined,
        model: request.model,
        effort: request.effort,
        auditMetadata: request.auditMetadata,
        threadId: request.threadId,
        mode: request.mode,
        exchange: request.exchange,
      }),
    },
  );

  if (passthrough.status !== 200) {
    return {
      ok: false,
      status: passthrough.status,
      text: await passthrough.text(),
    };
  }

  // The agent service mints the thread id, so the response body is the only
  // place it exists at this point.
  const result = (await passthrough.json().catch(() => null)) as {
    threadId?: unknown;
    threadTurn?: unknown;
  } | null;

  return {
    ok: true,
    ...(typeof result?.threadId === "string"
      ? { threadId: result.threadId }
      : {}),
    ...(typeof result?.threadTurn === "number"
      ? { threadTurn: result.threadTurn }
      : {}),
  };
}
