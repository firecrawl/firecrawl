import { Response } from "express";
import { AgentStatusResponse, RequestWithAuth } from "./types";
import {
  supabaseGetAgentByIdDirect,
  supabaseGetAgentRequestByIdDirect,
} from "../../lib/supabase-jobs";
import { logger as _logger } from "../../lib/logger";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import { isMaxCreditsError, normalizeMaxCreditsError } from "./agent-errors";

export async function agentStatusController(
  req: RequestWithAuth<{ jobId: string }, AgentStatusResponse, any>,
  res: Response<AgentStatusResponse>,
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

  let data: any = undefined;
  let partial: any = undefined;
  if (agent?.is_successful) {
    data = await getJobFromGCS(agent.id);
  }

  const status = !agent
    ? "processing"
    : agent.is_successful
      ? "completed"
      : "failed";
  const normalizedError = normalizeMaxCreditsError(agent?.error);
  const hasMaxCreditsError =
    status === "failed" && isMaxCreditsError(agent?.error);

  if (hasMaxCreditsError) {
    partial = await getJobFromGCS(agent.id);
  }

  return res.status(200).json({
    success: true,
    status,
    error: normalizedError,
    data,
    partial,
    expiresAt: new Date(
      new Date(agent?.created_at ?? agentRequest.created_at).getTime() +
        1000 * 60 * 60 * 24,
    ).toISOString(),
    creditsUsed: agent?.credits_cost,
  });
}
