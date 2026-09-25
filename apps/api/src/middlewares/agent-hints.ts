import type { RequestHandler } from "express";
import { config } from "../config";
import type { RequestWithMaybeAuth } from "../controllers/v1/types";
import {
  buildAgentHints,
  type AgentHintEndpoint,
  type AgentHintSurface,
} from "../lib/agent-hints";

/** Only registered on business POST routes, never feedback or polling routes. */
export function agentHintsMiddleware(
  endpoint: AgentHintEndpoint,
): RequestHandler {
  return (req, res, next) => {
    // "true" opts in with REST wording; "mcp" names the Firecrawl MCP tools.
    const optIn = req.get("X-Firecrawl-Agent-Hints")?.trim().toLowerCase();
    if (optIn !== "true" && optIn !== "mcp") return next();
    const surface: AgentHintSurface = optIn === "mcp" ? "mcp" : "http";
    const json = res.json;
    res.json = function (body) {
      if (!body || typeof body !== "object" || Array.isArray(body))
        return json.call(this, body);
      const teamId = (req as RequestWithMaybeAuth).auth?.team_id;
      const hints = buildAgentHints({
        endpoint,
        response: body,
        remainingCredits: res.locals.agentCreditsRemaining,
        canUseMapAndCrawl: !!teamId && !teamId.startsWith("preview_keyless_"),
        canUseInteract: config.USE_DB_AUTHENTICATION === true,
        surface,
      });
      return json.call(
        this,
        hints.length > 0 ? { ...body, agent_hints: hints } : body,
      );
    };
    next();
  };
}
