import { config } from "../config";
import { agentConsumeFreeRequestIfLeft } from "../db/rpc";
import { logRequest } from "../services/logging/log_job";
import type { AgentRequest } from "../controllers/v2/types";
import {
  AGENT_DEFAULT_MAX_CREDITS,
  gateAgentCredits,
} from "../controllers/v2/agent-credit-gate";
import { AGENT_REQUEST_CREDITS_SHARDS } from "./request-credits-store";

type LaunchAgentJobResult =
  | { ok: true; threadId?: string; threadTurn?: number }
  | { ok: false; reason: "insufficient_credits"; balance: number }
  | { ok: false; reason: "passthrough_failed"; status: number; text: string };

// Consumes a free request if one is left, gates paid runs on the team's
// credits, logs the request and hands the job to the agent service. Shared by POST /v2/agent and the Slack integration so
// both bill and record agent runs the same way.
export async function launchAgentJob(params: {
  agentId: string;
  teamId: string;
  apiKey: string;
  apiKeyId: number | null;
  orgId: string | null | undefined;
  externalRequestId?: string | null;
  request: AgentRequest;
  zeroDataRetention?: boolean;
  // The team's agent ZDR retention tier, forwarded only for ZDR runs.
  zeroDataRetentionMinutes?: number | null;
}): Promise<LaunchAgentJobResult> {
  const { agentId, teamId, request } = params;
  const zeroDataRetention = params.zeroDataRetention === true;

  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  // A request above the free cap is always paid. Otherwise a free request is
  // consumed atomically here, and only a consumed one skips the credit gate.
  const highCreditRequest =
    request.maxCredits !== undefined &&
    request.maxCredits > AGENT_DEFAULT_MAX_CREDITS;

  let freeRequest: any;

  if (config.USE_DB_AUTHENTICATION && !highCreditRequest) {
    freeRequest = await agentConsumeFreeRequestIfLeft(teamId);
  }

  const isFreeRequest = highCreditRequest
    ? false
    : config.USE_DB_AUTHENTICATION
      ? !!freeRequest?.[0]?.consumed
      : true;

  let maxCredits = request.maxCredits;
  let stopOnInsufficientCredits = false;
  if (!isFreeRequest) {
    const gate = await gateAgentCredits({
      teamId,
      orgId: params.orgId,
      apiKeyId: params.apiKeyId,
      requestedMaxCredits: request.maxCredits,
    });
    if (!gate.allowed) {
      return {
        ok: false,
        reason: "insufficient_credits",
        balance: gate.balance,
      };
    }
    maxCredits = gate.maxCredits;
    stopOnInsufficientCredits = gate.stopOnInsufficientCredits;
  }

  await logRequest({
    id: agentId,
    kind: "agent",
    api_version: "v2",
    external_request_id: params.externalRequestId ?? null,
    team_id: teamId,
    origin: request.origin ?? "api",
    integration: request.integration,
    target_hint: request.urls?.[0] ?? request.prompt ?? "",
    zeroDataRetention,
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
        maxCredits: maxCredits ?? undefined,
        stopOnInsufficientCredits: stopOnInsufficientCredits || undefined,
        strictConstrainToURLs: request.strictConstrainToURLs ?? undefined,
        webhook: request.webhook ?? undefined,
        model: request.model,
        effort: request.effort,
        auditMetadata: request.auditMetadata,
        threadId: request.threadId,
        mode: request.mode,
        exchange: request.exchange,
        location: request.location,
        ...(zeroDataRetention ? { zeroDataRetention: true } : {}),
        ...(zeroDataRetention &&
        params.zeroDataRetentionMinutes !== undefined &&
        params.zeroDataRetentionMinutes !== null
          ? { zeroDataRetentionMinutes: params.zeroDataRetentionMinutes }
          : {}),
      }),
    },
  );

  if (passthrough.status !== 200) {
    return {
      ok: false,
      reason: "passthrough_failed",
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
