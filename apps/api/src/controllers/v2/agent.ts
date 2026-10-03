import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import {
  AgentRequest,
  AgentResponse,
  RequestWithAuth,
  agentRequestSchema,
} from "./types";
import { logger as _logger } from "../../lib/logger";
import { externalRequestId } from "../../lib/external-request-id";
import { config } from "../../config";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import {
  checkUrlsAgainstThreatPolicy,
  resolveThreatProtection,
} from "../../lib/threat-protection/request";
import { UnsafeDomainBlockedError } from "../../lib/threat-protection/error";
import { calculateThreatScanCredits } from "../../lib/scrape-billing";
import { billTeam } from "../../services/billing/credit_billing";
import { emitRejectedScrapeActivityEvents } from "../../lib/siem-logging";
import { fetchAgentThread, threadErrorFor } from "./agent-thread";
import { launchAgentJob } from "../../lib/agent-launch";

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
          req.acuc?.org_id ?? null,
          threatScanCredits,
          req.acuc?.api_key_id ?? null,
          { endpoint: "agent", jobId: agentId, chargeId: `${agentId}:threat` },
        ).catch(error => {
          logger.error(
            `Failed to bill team ${req.auth.team_id} for ${threatScanCredits} threat scan credit(s): ${error}`,
          );
        });
      }
      const first = blocked[0];
      const error = new UnsafeDomainBlockedError(first.url, first.decision);
      emitRejectedScrapeActivityEvents(
        blocked.map(blockedUrl => ({
          scrapeId: uuidv7(),
          requestId: agentId,
          endpoint: "agent",
          teamId: req.auth.team_id,
          apiKeyId: req.acuc?.api_key_id ?? null,
          auditMetadata: req.body.auditMetadata,
          url: blockedUrl.url,
          error: new UnsafeDomainBlockedError(
            blockedUrl.url,
            blockedUrl.decision,
          ),
          threatDecisions: [blockedUrl.decision],
          origin: req.body.origin ?? "api",
          integration: req.body.integration,
          zeroDataRetention: false,
        })),
      );
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

  // A follow-up is validated before the free request is consumed and before
  // logRequest, so a rejected continuation leaves no orphan request row.
  if (req.body.threadId) {
    const thread = await fetchAgentThread(
      req.body.threadId,
      req.auth.team_id,
    ).catch(error => {
      logger.error("Failed to check agent thread.", { error });
      return null;
    });

    if (thread === null) {
      return res.status(500).json({
        success: false,
        error: "Failed to check agent thread.",
      });
    }

    if (thread.status !== 200) {
      const mapped = threadErrorFor(thread.status);

      if (!mapped) {
        logger.error("Failed to check agent thread.", {
          status: thread.status,
          text: await thread.text(),
        });

        return res.status(500).json({
          success: false,
          error: "Failed to check agent thread.",
        });
      }

      const body = (await thread.json().catch(() => null)) as {
        runId?: unknown;
      } | null;

      return res.status(thread.status).json({
        success: false,
        code: mapped.code,
        error: mapped.error,
        ...(typeof body?.runId === "string" ? { runId: body.runId } : {}),
      });
    }
  }

  const launched = await launchAgentJob({
    agentId,
    teamId: req.auth.team_id,
    apiKey: req.acuc!.api_key,
    apiKeyId: req.acuc?.api_key_id ?? null,
    externalRequestId: externalRequestId(req),
    request: req.body,
  });

  if (!launched.ok) {
    logger.error("Failed to passthrough agent request.", {
      status: launched.status,
      text: launched.text,
    });

    // TODO: should we try to insert a failed agent row here, since a request is already created? - Mogery

    return res.status(500).json({
      success: false,
      error: "Failed to passthrough agent request.",
    });
  }

  return res.status(200).json({
    success: true,
    id: agentId,
    ...(launched.threadId !== undefined ? { threadId: launched.threadId } : {}),
    ...(launched.threadTurn !== undefined
      ? { threadTurn: launched.threadTurn }
      : {}),
  });
}
