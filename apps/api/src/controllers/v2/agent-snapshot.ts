import { Response } from "express";
import { config } from "../../config";
import { supabaseGetAgentRequestByIdDirect } from "../../lib/supabase-jobs";
import { AgentSnapshotResponse, RequestWithAuth } from "./types";

export async function agentSnapshotController(
  req: RequestWithAuth<
    { jobId: string; snapshotId: string },
    AgentSnapshotResponse,
    any
  >,
  res: Response<AgentSnapshotResponse>,
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

  const upstream = await fetch(
    `${config.EXTRACT_V3_BETA_URL}/internal/extracts/${req.params.jobId}/snapshots/${req.params.snapshotId}`,
    {
      headers: {
        Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
      },
    },
  );
  const body = (await upstream.json()) as AgentSnapshotResponse;

  return res.status(upstream.status).json(body);
}
