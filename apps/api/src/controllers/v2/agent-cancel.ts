import { Response } from "express";
import { AgentCancelResponse, RequestWithAuth } from "./types";
import { config } from "../../config";
import { getAgentJobAccess } from "../../lib/operational-job-access";

export async function agentCancelController(
  req: RequestWithAuth<{ jobId: string }, AgentCancelResponse, any>,
  res: Response<AgentCancelResponse>,
) {
  const access = await getAgentJobAccess(req.params.jobId);

  if (
    !access ||
    access.expiresAtMs <= Date.now() ||
    access.teamId !== req.auth.team_id
  ) {
    return res.status(404).json({
      success: false,
      error: "Agent job not found",
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
    const body = (await resp.json().catch(() => null)) as {
      error?: string;
    } | null;
    return res.status(409).json({
      success: false,
      error:
        body?.error === "Agent already finished"
          ? body.error
          : "Agent is already cancelled",
    });
  }

  if (!resp.ok) {
    return res.status(500).json({
      success: false,
      error: "Failed to cancel agent",
    });
  }

  return res.status(200).json({
    success: true,
  });
}
