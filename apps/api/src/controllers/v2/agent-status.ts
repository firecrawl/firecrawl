import { Response } from "express";
import {
  AgentExchangeSummary,
  AgentMode,
  AgentPendingApproval,
  AgentStatusResponse,
  AgentSuggestion,
  RequestWithAuth,
} from "./types";
import { getAgentJobAccess } from "../../lib/operational-job-access";
import { getExtractV3AgentStatus } from "../../lib/extract-v3-status";

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

type ThreadOptions = {
  threadId?: string;
  threadTurn?: number;
  mode?: AgentMode;
};

function readThreadOptions(options: any): ThreadOptions {
  return {
    threadId: options?.threadId,
    threadTurn: options?.threadTurn,
    mode: options?.mode,
  };
}

export async function agentStatusController(
  req: RequestWithAuth<{ jobId: string }, AgentStatusResponse, any>,
  res: Response<AgentStatusResponse>,
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

  const agent = await getExtractV3AgentStatus(req.params.jobId);

  let model: "spark-1-pro" | "spark-1-mini" | "spark-2" =
    agent.model ?? "spark-1-pro";
  // The agent service persists the effort of a run that used it. Older rows
  // and runs that picked a model have no effort, so this stays undefined.
  const effort = agent.effort;
  const thread = readThreadOptions(agent);

  // Lie about the model to python-sdk versions that cannot parse "spark-2"
  // (see isIncompatiblePythonSdkOrigin). Only spark-2 needs disguising — a
  // genuine spark-1 preset name parses fine on every SDK version, so legacy
  // rows keep their truthful value.
  if (
    model !== "spark-1-pro" &&
    model !== "spark-1-mini" &&
    isIncompatiblePythonSdkOrigin(access.clientOrigin)
  ) {
    model = "spark-1-pro";
  }

  return res.status(200).json({
    success: true,
    status: agent.status === "success" ? "completed" : agent.status,
    error: agent.error,
    data: agent.data,
    model,
    effort,
    threadId: thread.threadId,
    threadTurn: thread.threadTurn,
    mode: thread.mode,
    message: agent.message,
    suggestions: agent.suggestions as AgentSuggestion[] | undefined,
    pendingApproval: agent.pendingApproval as AgentPendingApproval | undefined,
    exchange: agent.exchange as AgentExchangeSummary | undefined,
    expiresAt: new Date(access.expiresAtMs).toISOString(),
    creditsUsed: agent.creditsUsed,
  });
}
