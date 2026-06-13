import { Response } from "express";
import { AgentStatusResponse, RequestWithAuth } from "./types";
import {
  supabaseGetAgentByIdDirect,
  supabaseGetAgentRequestByIdDirect,
} from "../../lib/supabase-jobs";
import { logger as _logger, logger } from "../../lib/logger";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import { config } from "../../config";

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

  let model: "spark-1-pro" | "spark-1-mini" | undefined;
  if (agent) {
    const agentModel = agent.options?.model;
    model =
      agentModel === "spark-1-pro" || agentModel === "spark-1-mini"
        ? agentModel
        : undefined;
  } else {
    try {
      const optionsRequest = await fetch(
        config.EXTRACT_V3_BETA_URL +
          "/v2/extract/" +
          req.params.jobId +
          "/options",
        {
          headers: {
            Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
          },
        },
      );

      if (optionsRequest.status !== 200) {
        logger.warn("Failed to get agent request details", {
          status: optionsRequest.status,
          method: "agentStatusController",
          module: "api/v2",
          text: await optionsRequest.text(),
        });
        model = undefined;
      } else {
        const optionsModel = (await optionsRequest.json()).model;
        model =
          optionsModel === "spark-1-pro" || optionsModel === "spark-1-mini"
            ? optionsModel
            : undefined;
      }
    } catch (error) {
      logger.warn("Failed to get agent request details", {
        error,
        method: "agentStatusController",
        module: "api/v2",
        extractId: req.params.jobId,
      });
      model = undefined;
    }
  }

  let data: any = undefined;
  if (agent?.is_successful) {
    data = await getJobFromGCS(agent.id);
  }

  return res.status(200).json({
    success: true,
    status: !agent
      ? "processing"
      : agent.is_successful
        ? "completed"
        : "failed",
    error: agent?.error || undefined,
    data,
    model,
    expiresAt: new Date(
      new Date(agent?.created_at ?? agentRequest.created_at).getTime() +
        1000 * 60 * 60 * 24,
    ).toISOString(),
    creditsUsed: agent?.credits_cost,
  });
}
