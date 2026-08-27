import { Response } from "express";
import { AgentStatusResponse, RequestWithAuth } from "./types";
import {
  supabaseGetAgentByIdDirect,
  supabaseGetAgentRequestByIdDirect,
} from "../../lib/supabase-jobs";
import { logger as _logger, logger } from "../../lib/logger";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import { config } from "../../config";

// python-sdk versions before 4.37.1 validate the status response's `model`
// with pydantic as Literal["spark-1-pro", "spark-1-mini"], so any other value
// raises ValidationError inside get_agent_status — which wait_agent() and the
// blocking agent() wrapper both poll — killing the whole agent flow on the
// first status check. Those versions predate spark-2, so a job they started
// can only have requested a spark-1 preset or nothing at all; reporting the
// old default back to them is wrong in telemetry but keeps their poll loop
// alive. A python-sdk origin whose version does not parse cleanly is
// treated as incompatible: the lie is cosmetic, the crash is not. The
// version regex is end-anchored so a prerelease of the fix (e.g.
// "4.37.1rc0", which may predate the Literal widening) also fails to
// parse and gets lied to rather than crashed.
const PYTHON_SDK_ORIGIN = /^python-sdk@(.+)$/;
const PYTHON_SDK_SPARK_2_FIX = [4, 37, 1];

function isIncompatiblePythonSdkOrigin(origin: unknown): boolean {
  if (typeof origin !== "string") return false;
  const sdk = PYTHON_SDK_ORIGIN.exec(origin);
  if (!sdk) return false;
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(sdk[1]);
  if (!version) return true;
  const [major, minor, patch] = version.slice(1).map(Number);
  return (
    major < PYTHON_SDK_SPARK_2_FIX[0] ||
    (major === PYTHON_SDK_SPARK_2_FIX[0] &&
      minor < PYTHON_SDK_SPARK_2_FIX[1]) ||
    (major === PYTHON_SDK_SPARK_2_FIX[0] &&
      minor === PYTHON_SDK_SPARK_2_FIX[1] &&
      patch < PYTHON_SDK_SPARK_2_FIX[2])
  );
}

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
        model = "spark-1-pro"; // fall back to this value
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
      model = "spark-1-pro"; // fall back to this value
    }
  }

  // Lie about the model to python-sdk versions that cannot parse "spark-2"
  // (see isIncompatiblePythonSdkOrigin). Only spark-2 needs disguising — a
  // genuine spark-1 preset name parses fine on every SDK version, so legacy
  // rows keep their truthful value.
  if (
    model !== "spark-1-pro" &&
    model !== "spark-1-mini" &&
    isIncompatiblePythonSdkOrigin(agentRequest.origin)
  ) {
    model = "spark-1-pro";
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
