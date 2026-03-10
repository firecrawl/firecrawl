import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import {
  AgentRequest,
  AgentResponse,
  RequestWithAuth,
  agentRequestSchema,
} from "./types";
import { logger as _logger } from "../../lib/logger";
import { logRequest } from "../../services/logging/log_job";
import { config } from "../../config";
import { supabase_service } from "../../services/supabase";

export async function agentController(
  req: RequestWithAuth<{}, AgentResponse, AgentRequest>,
  res: Response<AgentResponse>,
) {
  const agentId = uuidv7();
  const logger = _logger.child({
    agentId,
    extractId: agentId,
    jobId: agentId,
    teamId: req.auth.team_id,
    team_id: req.auth.team_id,
    module: "api/v2",
    method: "agentController",
    zeroDataRetention: req.acuc?.flags?.forceZDR,
  });

  const originalRequest = { ...req.body };
  req.body = agentRequestSchema.parse(req.body);

  if (req.acuc?.flags?.forceZDR) {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on extract. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  _logger.info("Agent starting...", {
    request: req.body,
    originalRequest,
    subId: req.acuc?.sub_id,
    zeroDataRetention: req.acuc?.flags?.forceZDR,
  });

  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  let freeRequest: any;

  if (config.USE_DB_AUTHENTICATION) {
    const { data, error: freeRequestError } = await supabase_service.rpc(
      "agent_consume_free_request_if_left",
      {
        i_team_id: req.auth.team_id,
      },
    );

    if (freeRequestError) {
      throw freeRequestError;
    }

    freeRequest = data;
  }

  const isFreeRequest = config.USE_DB_AUTHENTICATION
    ? !!freeRequest?.[0]?.consumed
    : true;

  await logRequest({
    id: agentId,
    kind: "agent",
    api_version: "v2",
    team_id: req.auth.team_id,
    origin: req.body.origin ?? "api",
    integration: req.body.integration,
    target_hint: req.body.urls?.[0] ?? req.body.prompt ?? "",
    zeroDataRetention: false, // not supported for agent
    api_key_id: req.acuc?.api_key_id ?? null,
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
        urls: req.body.urls,
        schema: req.body.schema,
        prompt: req.body.prompt,
        apiKey: req.acuc!.api_key,
        apiKeyId: req.acuc!.api_key_id ?? undefined,
        teamId: req.auth.team_id,
        isFreeRequest,
        maxCredits: req.body.maxCredits ?? undefined,
        strictConstrainToURLs: req.body.strictConstrainToURLs ?? undefined,
        webhook: req.body.webhook ?? undefined,
        model: req.body.model,
      }),
    },
  );

  if (passthrough.status !== 200) {
    const text = await passthrough.text();

    logger.error("Failed to passthrough agent request.", {
      status: passthrough.status,
      text,
    });
    return res.status(500).json({
      success: false,
      error: "Failed to passthrough agent request.",
    });
  }

  return res.status(200).json({
    success: true,
    id: agentId,
  });
}
