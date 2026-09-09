import { Response } from "express";
import { config } from "../../config";
import { listActiveBrowserSessionsForRequest } from "../../lib/browser-sessions";
import { supabaseGetAgentRequestByIdDirect } from "../../lib/supabase-jobs";
import { AgentTraceResponse, RequestWithAuth } from "./types";

const AGENT_BROWSER_VIEWPORT = { width: 1280, height: 720 } as const;

export async function agentTraceController(
  req: RequestWithAuth<{ jobId: string }, AgentTraceResponse, any>,
  res: Response<AgentTraceResponse>,
) {
  const agentRequest = await supabaseGetAgentRequestByIdDirect(
    req.params.jobId,
  );

  if (!agentRequest || agentRequest.team_id !== req.auth.team_id) {
    return res.status(404).json({
      success: false,
      error: "Agent job not found",
    });
  }

  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  const includeLiveView = req.query.liveView === "true";

  const [upstream, activeBrowserSessions] = await Promise.all([
    fetch(
      `${config.EXTRACT_V3_BETA_URL}/internal/extracts/${req.params.jobId}/trace`,
      {
        headers: {
          Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
        },
      },
    ),
    includeLiveView
      ? listActiveBrowserSessionsForRequest(req.auth.team_id, req.params.jobId)
      : Promise.resolve([]),
  ]);
  const body = (await upstream.json()) as AgentTraceResponse;

  if (!upstream.ok || body.success !== true) {
    return res.status(upstream.status).json(body);
  }

  return res.status(upstream.status).json({
    ...body,
    ...(includeLiveView
      ? {
          activeBrowserSessions: activeBrowserSessions.map(session => ({
            id: session.id,
            liveViewUrl: session.cdp_path,
            viewport: AGENT_BROWSER_VIEWPORT,
          })),
        }
      : {}),
  });
}
