import { Response } from "express";
import { validate as isUuid } from "uuid";
import { config } from "../../config";
import { RequestWithAuth } from "./types";

// The agent service is internal; these routes are the only way the dashboard
// reaches its run options, feedback, settings and share links.
async function forwardToAgentService(
  res: Response,
  path: string,
  init: RequestInit,
) {
  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  const upstream = await fetch(`${config.EXTRACT_V3_BETA_URL}${path}`, init);
  const body = await upstream.json().catch(() => ({}));
  return res.status(upstream.status).json(body);
}

// The agent service answers 404 when x-team-id does not own the run.
function interopHeaders(teamId: string) {
  return {
    Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
    "x-team-id": teamId,
  };
}

function callerHeaders(req: RequestWithAuth<any, any, any>) {
  return {
    Authorization: req.headers.authorization ?? "",
    "Content-Type": "application/json",
  };
}

export function agentFeedbackController(kind: "like" | "dislike") {
  return (req: RequestWithAuth<{ jobId: string }, any, any>, res: Response) =>
    forwardToAgentService(
      res,
      `/internal/extracts/${encodeURIComponent(req.params.jobId)}/${kind}`,
      { method: "POST", headers: interopHeaders(req.auth.team_id) },
    );
}

export function agentOptionsController(
  req: RequestWithAuth<{ jobId: string }, any, any>,
  res: Response,
) {
  return forwardToAgentService(
    res,
    `/v2/extract/${encodeURIComponent(req.params.jobId)}/options`,
    { headers: interopHeaders(req.auth.team_id) },
  );
}

// Unlike GET /agent/:jobId, this reads runs past the 24 hour job TTL.
export function agentResultController(
  req: RequestWithAuth<{ jobId: string }, any, any>,
  res: Response,
) {
  return forwardToAgentService(
    res,
    `/v2/extract/${encodeURIComponent(req.params.jobId)}`,
    { headers: callerHeaders(req) },
  );
}

export function agentSettingsController(
  req: RequestWithAuth<{ jobId: string }, any, any>,
  res: Response,
) {
  return forwardToAgentService(
    res,
    `/v2/sessions/${encodeURIComponent(req.params.jobId)}/settings`,
    {
      method: req.method,
      headers: callerHeaders(req),
      ...(req.method === "PATCH" ? { body: JSON.stringify(req.body) } : {}),
    },
  );
}

export function agentShareController(
  req: RequestWithAuth<{ jobId: string }, any, any>,
  res: Response,
) {
  return forwardToAgentService(
    res,
    `/v2/sessions/${encodeURIComponent(req.params.jobId)}/share`,
    { method: req.method, headers: callerHeaders(req) },
  );
}

export async function agentSharedRunController(
  req: RequestWithAuth<{ shareId: string }, any, any>,
  res: Response,
) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (!isUuid(req.params.shareId)) {
    return res.status(404).json({ error: "Share link not found" });
  }

  return forwardToAgentService(
    res,
    `/v2/sessions/share/${encodeURIComponent(req.params.shareId)}`,
    {},
  );
}
