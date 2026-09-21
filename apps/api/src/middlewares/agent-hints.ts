import type { RequestHandler } from "express";
import { buildAgentHints, type AgentHintEndpoint } from "../lib/agent-hints";

/** Only registered on business POST routes, never feedback or polling routes. */
export function agentHintsMiddleware(
  endpoint: AgentHintEndpoint,
): RequestHandler {
  return (req, res, next) => {
    if (req.get("X-Firecrawl-Agent-Hints")?.trim().toLowerCase() !== "true")
      return next();
    const json = res.json;
    res.json = function (body) {
      if (!body || typeof body !== "object" || Array.isArray(body))
        return json.call(this, body);
      const hints = buildAgentHints({
        endpoint,
        response: body,
        remainingCredits: res.locals.agentCreditsRemaining,
      });
      return json.call(
        this,
        hints.length > 0 ? { ...body, agent_hints: hints } : body,
      );
    };
    next();
  };
}
