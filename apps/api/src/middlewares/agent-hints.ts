import type { RequestHandler, Response } from "express";
import { config } from "../config";
import { buildAgentHints, type AgentHintEndpoint } from "../lib/agent-hints";
import type { RequestWithAuth } from "../controllers/v2/types";

/** Controllers opt in only after producing a feedback-supported job. */
export function setAgentHintFeedback(
  res: Response,
  jobId: string,
  zeroDataRetention: boolean = false,
): void {
  res.locals ??= {};
  res.locals.agentHintFeedback = { jobId, zeroDataRetention };
}

/** Only registered on business POST routes, never feedback or polling routes. */
export function agentHintsMiddleware(
  endpoint: AgentHintEndpoint,
): RequestHandler {
  return (req, res, next) => {
    if (req.get("X-Firecrawl-Agent-Hints")?.trim().toLowerCase() === "false")
      return next();
    const json = res.json;
    res.json = function (body) {
      if (!body || typeof body !== "object" || Array.isArray(body))
        return json.call(this, body);
      const authReq = req as RequestWithAuth<any, any, any>;
      const teamId = authReq.auth?.team_id;
      const feedback = res.locals.agentHintFeedback;
      const canSubmitFeedback =
        config.USE_DB_AUTHENTICATION === true &&
        typeof teamId === "string" &&
        teamId !== "preview" &&
        !teamId.startsWith("preview_") &&
        authReq.acuc?.flags?.searchFeedbackOptOut !== true &&
        feedback &&
        !feedback.zeroDataRetention;
      const hints = buildAgentHints({
        endpoint,
        response: body,
        feedbackJobId: canSubmitFeedback ? feedback.jobId : undefined,
        searchFeedbackMaxAgeSec: config.SEARCH_FEEDBACK_MAX_AGE_SEC,
      });
      return json.call(
        this,
        hints.length > 0 ? { ...body, agent_hints: hints } : body,
      );
    };
    next();
  };
}
