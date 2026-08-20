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

  // Jobs whose stored options carry no model predate the model option and ran
  // on spark-1-pro, so the fallback here stays spark-1-pro even though the
  // agent request schema now defaults new jobs to spark-2.
  let model: "spark-1-pro" | "spark-1-mini" | "spark-2";
  // The agent service persists the effort of a run that used it. Older rows
  // and runs that picked a model have no effort, so this stays undefined.
  let effort: "low" | "medium" | "high" | undefined;
  if (agent) {
    model = (agent.options?.model ?? "spark-1-pro") as
      | "spark-1-pro"
      | "spark-1-mini"
      | "spark-2";
    effort = agent.options?.effort as "low" | "medium" | "high" | undefined;
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
        model = "spark-1-pro"; // fall back to the pre-model-option default
      } else {
        const options = await optionsRequest.json();
        model = (options.model ?? "spark-1-pro") as
          | "spark-1-pro"
          | "spark-1-mini"
          | "spark-2";
        effort = options.effort as "low" | "medium" | "high" | undefined;
      }
    } catch (error) {
      logger.warn("Failed to get agent request details", {
        error,
        method: "agentStatusController",
        module: "api/v2",
        extractId: req.params.jobId,
      });
      model = "spark-1-pro"; // fall back to the pre-model-option default
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
    effort,
    expiresAt: new Date(
      new Date(agent?.created_at ?? agentRequest.created_at).getTime() +
        1000 * 60 * 60 * 24,
    ).toISOString(),
    creditsUsed: agent?.credits_cost,
  });
}
