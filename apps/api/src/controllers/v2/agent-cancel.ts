import { Response } from "express";
import { AgentCancelResponse, RequestWithAuth } from "./types";
import {
  supabaseGetAgentByIdDirect,
  supabaseGetAgentRequestByIdDirect,
} from "../../lib/supabase-jobs";
import { config } from "../../config";

export async function agentCancelController(
  req: RequestWithAuth<{ jobId: string }, AgentCancelResponse, any>,
  res: Response<AgentCancelResponse>,
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

  const agent = await supabaseGetAgentByIdDirect(req.params.jobId);
  if (agent) {
    return res.status(409).json({
      success: false,
      error: "Agent already finished",
    });
  }

  const resp = await fetch(
    config.EXTRACT_V3_BETA_URL + "/internal/extracts/" + req.params.jobId,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
      },
    },
  );

  if (resp.status === 409) {
    return res.status(409).json({
      success: false,
      error: "Agent is already cancelled",
    });
  }

  return res.status(200).json({
    success: true,
  });
}
