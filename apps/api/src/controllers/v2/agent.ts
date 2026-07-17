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
import { agentConsumeFreeRequestIfLeft } from "../../db/rpc";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import {
  checkUrlsAgainstThreatPolicy,
  resolveThreatProtection,
} from "../../lib/threat-protection/request";
import { UnsafeDomainBlockedError } from "../../lib/threat-protection/error";
import { calculateThreatScanCredits } from "../../lib/scrape-billing";
import { billTeam } from "../../services/billing/credit_billing";

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
    zeroDataRetention: getScrapeZDR(req.acuc?.flags) === "forced",
  });

  const originalRequest = { ...req.body };
  req.body = agentRequestSchema.parse(req.body);

  if (getScrapeZDR(req.acuc?.flags) === "forced") {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on extract. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  _logger.info("Agent starting...", {
    request: req.body,
    originalRequest,
    zeroDataRetention: getScrapeZDR(req.acuc?.flags) === "forced",
  });

  // Threat protection: check the agent's starting URLs before handing off to
  // the agent service. Content the agent fetches through the API
  // (agent-interop scrapes) is additionally enforced by the scrape pipeline's
  // org-policy resolution; in-page navigations performed by the remote
  // browser cannot be intercepted here.
  const threatProtection = await resolveThreatProtection({
    teamId: req.auth.team_id,
    orgId: req.acuc?.org_id ?? null,
    flags: req.acuc?.flags ?? null,
    override: req.body.threatProtection,
  });
  if (threatProtection.error) {
    return res.status(403).json({
      success: false,
      error: threatProtection.error,
    });
  }
  if (threatProtection.policy && (req.body.urls?.length ?? 0) > 0) {
    const { blocked, decisionsByUrl } = await checkUrlsAgainstThreatPolicy(
      req.body.urls ?? [],
      threatProtection.policy,
      { teamId: req.auth.team_id },
    );
    if (blocked.length > 0) {
      // The whole request is rejected below, so no agent job will ever run
      // to bill the allowed start URLs' scans — every consulted decision
      // (allowed and blocked) bills its scan fee here (+2 per unique
      // scanned URL): the scans already happened.
      const threatScanCredits = calculateThreatScanCredits(
        decisionsByUrl.values(),
      );
      if (threatScanCredits > 0) {
        billTeam(
          req.auth.team_id,
          threatScanCredits,
          req.acuc?.api_key_id ?? null,
          { endpoint: "agent", jobId: agentId },
        ).catch(error => {
          logger.error(
            `Failed to bill team ${req.auth.team_id} for ${threatScanCredits} threat scan credit(s): ${error}`,
          );
        });
      }
      const first = blocked[0];
      const error = new UnsafeDomainBlockedError(first.url, first.decision);
      return res.status(403).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }
  }

  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  // If maxCredits > 2500, skip free request consumption — this is always a paid request
  const highCreditRequest =
    req.body.maxCredits !== undefined && req.body.maxCredits > 2500;

  let freeRequest: any;

  if (config.USE_DB_AUTHENTICATION && !highCreditRequest) {
    freeRequest = await agentConsumeFreeRequestIfLeft(req.auth.team_id);
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
