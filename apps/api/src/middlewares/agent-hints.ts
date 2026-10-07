import type { Request, RequestHandler, Response } from "express";
import { config } from "../config";
import type { RequestWithMaybeAuth } from "../controllers/v1/types";
import { evaluateAgentHintRules } from "../lib/agent-hint-rules";
import {
  computeAgentHintSignals,
  type AgentHintEndpoint,
} from "../lib/agent-hint-signals";
import { buildAgentHints } from "../lib/agent-hints";
import {
  agentHintsProviderRequestsTotal,
  getProviderHints,
  mergeAgentHints,
  providerTeamId,
  type ProviderHintsHolder,
} from "../lib/agent-hints-provider";
import { keylessSignupSurface } from "../lib/keyless-signup-link";
import { logger } from "../lib/logger";

function agentHintsRequested(req: Request): boolean {
  return req.get("X-Firecrawl-Agent-Hints")?.trim().toLowerCase() === "true";
}

function agentHintsFor(
  req: Request,
  res: Response,
  endpoint: AgentHintEndpoint,
  body: Record<string, unknown>,
): string[] {
  const teamId = (req as RequestWithMaybeAuth).auth?.team_id;
  const provider: ProviderHintsHolder | undefined =
    res.locals.agentHintsProvider;
  const context = {
    endpoint,
    response: body,
    remainingCredits: res.locals.agentCreditsRemaining,
    canUseMapAndCrawl: !!teamId && !teamId.startsWith("preview_keyless_"),
    canUseInteract: config.USE_DB_AUTHENTICATION === true,
  };
  const rules = provider?.settled ? provider.rules : [];
  const { hints, providerHintIds } = mergeAgentHints(
    rules.length > 0
      ? evaluateAgentHintRules(rules, computeAgentHintSignals(context))
      : buildAgentHints(context),
    provider?.settled && body.success === true ? provider.hints : [],
  );
  if (providerHintIds.length > 0) {
    logger.info("Served external agent hints", {
      module: "agent-hints-provider",
      endpoint,
      team_id: teamId ? providerTeamId(teamId) : undefined,
      hint_ids: providerHintIds,
    });
  }
  return hints;
}

/**
 * Only registered on business POST routes, never feedback or polling routes.
 * Hint computation must never change the response otherwise: any error sends
 * the original body unchanged.
 */
export function agentHintsMiddleware(
  endpoint: AgentHintEndpoint,
): RequestHandler {
  return (req, res, next) => {
    if (!agentHintsRequested(req)) return next();
    const json = res.json;
    res.json = function (body) {
      if (!body || typeof body !== "object" || Array.isArray(body))
        return json.call(this, body);
      let output = body;
      try {
        const hints = agentHintsFor(req, res, endpoint, body);
        if (hints.length > 0) output = { ...body, agent_hints: hints };
      } catch (error) {
        agentHintsProviderRequestsTotal.inc({ outcome: "eval_error" });
        logger.warn("Agent hints computation failed", {
          module: "agent-hints",
          endpoint,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return json.call(this, output);
    };
    next();
  };
}

/**
 * Starts the optional external hints lookup. Must run after authMiddleware so
 * the team is known; it never waits for the provider.
 */
export function agentHintsProviderMiddleware(
  endpoint: AgentHintEndpoint,
): RequestHandler {
  return (req, res, next) => {
    if (!agentHintsRequested(req)) return next();
    const authReq = req as RequestWithMaybeAuth;
    const teamId = authReq.auth?.team_id;
    if (!teamId) return next();
    const apiKeyId = authReq.acuc?.api_key_id;
    try {
      res.locals.agentHintsProvider = getProviderHints({
        teamId,
        orgId: authReq.auth?.org_id ?? null,
        apiKeyId:
          typeof apiKeyId === "number" && Number.isFinite(apiKeyId)
            ? apiKeyId
            : null,
        endpoint,
        surface: keylessSignupSurface(req),
        keyless: teamId.startsWith("preview_keyless_"),
      });
    } catch (error) {
      logger.warn("Agent hints provider lookup could not start", {
        module: "agent-hints-provider",
        endpoint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    next();
  };
}
