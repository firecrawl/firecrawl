import type { Request, RequestHandler } from "express";
import { config } from "../config";
import type { RequestWithMaybeAuth } from "../controllers/v1/types";
import { buildAgentHints, type AgentHintEndpoint } from "../lib/agent-hints";
import {
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

/** Only registered on business POST routes, never feedback or polling routes. */
export function agentHintsMiddleware(
  endpoint: AgentHintEndpoint,
): RequestHandler {
  return (req, res, next) => {
    if (!agentHintsRequested(req)) return next();
    const json = res.json;
    res.json = function (body) {
      if (!body || typeof body !== "object" || Array.isArray(body))
        return json.call(this, body);
      const teamId = (req as RequestWithMaybeAuth).auth?.team_id;
      const provider: ProviderHintsHolder | undefined =
        res.locals.agentHintsProvider;
      const { hints, providerHintIds } = mergeAgentHints(
        buildAgentHints({
          endpoint,
          response: body,
          remainingCredits: res.locals.agentCreditsRemaining,
          canUseMapAndCrawl: !!teamId && !teamId.startsWith("preview_keyless_"),
          canUseInteract: config.USE_DB_AUTHENTICATION === true,
        }),
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
      return json.call(
        this,
        hints.length > 0 ? { ...body, agent_hints: hints } : body,
      );
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
    next();
  };
}
