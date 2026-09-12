import { Response } from "express";
import { config } from "../../config";
import { supabaseGetAgentRequestByIdDirect } from "../../lib/supabase-jobs";
import { AgentSkillResponse, RequestWithAuth } from "./types";

export async function agentSkillController(
  req: RequestWithAuth<{ jobId: string }, AgentSkillResponse, any>,
  res: Response<AgentSkillResponse>,
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

  const query = req.query.refresh === "1" ? "?refresh=1" : "";
  const upstream = await fetch(
    `${config.EXTRACT_V3_BETA_URL}/internal/extracts/${req.params.jobId}/skill${query}`,
    {
      headers: {
        Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
      },
    },
  );

  const body = (await upstream.json()) as AgentSkillResponse;

  // 404 (skills off, or nothing stored) and 409 (run still going, or it
  // produced no data) both mean "no skill yet" to the caller, so the upstream
  // status carries through rather than collapsing into a 500.
  return res.status(upstream.status).json(body);
}
