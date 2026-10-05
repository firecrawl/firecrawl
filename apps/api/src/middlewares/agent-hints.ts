import type { RequestHandler } from "express";
import { config } from "../config";
import type { RequestWithMaybeAuth } from "../controllers/v1/types";
import {
  buildAgentHintRecords,
  type AgentHint,
  type AgentHintEndpoint,
} from "../lib/agent-hints";
import { logger } from "../lib/logger";
import { trackAgentHints } from "../lib/tracking";
import { getScrapeZDR } from "../lib/zdr-helpers";

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}

/**
 * The id the hinted response already carries, so a hint row joins to the job
 * the agent saw. Search and map put it at the top level, scrape in the scrape
 * metadata; parse returns no id, which records as empty.
 */
function responseJobId(body: ObjectValue): string | null {
  const metadata = object(object(body.data).metadata);
  for (const candidate of [body.id, metadata.scrapeId, body.scrape_id]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

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
      const request = req as RequestWithMaybeAuth;
      const teamId = request.auth?.team_id;
      const hints: AgentHint[] = buildAgentHintRecords({
        endpoint,
        response: body,
        remainingCredits: res.locals.agentCreditsRemaining,
        canUseMapAndCrawl: !!teamId && !teamId.startsWith("preview_keyless_"),
        canUseInteract: config.USE_DB_AUTHENTICATION === true,
      });
      if (hints.length > 0 && teamId) {
        // Observation only: fire-and-forget, so a telemetry failure can never
        // change or delay the response the agent receives.
        trackAgentHints({
          hintIds: hints.map(hint => hint.id),
          endpoint,
          jobId: responseJobId(body),
          teamId,
          zeroDataRetention:
            getScrapeZDR(request.acuc?.flags) === "forced" ||
            (req.body as ObjectValue | undefined)?.zeroDataRetention === true,
        }).catch(error =>
          logger.warn("Agent hint tracking failed", { endpoint, error }),
        );
      }
      return json.call(
        this,
        hints.length > 0
          ? { ...body, agent_hints: hints.map(hint => hint.text) }
          : body,
      );
    };
    next();
  };
}
