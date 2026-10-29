import { Response } from "express";
import { config } from "../../config";
import { ErrorCodes } from "../../lib/error";
import { logger as _logger } from "../../lib/logger";
import { AgentThread, AgentThreadResponse, RequestWithAuth } from "./types";

const THREAD_ERRORS: Record<number, { code: ErrorCodes; error: string }> = {
  404: { code: "thread_not_found", error: "Agent thread not found" },
  409: {
    code: "thread_busy",
    error: "This thread already has a run in progress",
  },
  410: { code: "thread_expired", error: "Agent thread has expired" },
  503: { code: "threads_disabled", error: "Agent threads are not available" },
};

export function threadErrorFor(status: number) {
  return THREAD_ERRORS[status] ?? null;
}

export async function fetchAgentThread(
  threadId: string,
  teamId: string,
  options: { includeData?: boolean } = {},
) {
  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  const query = new URLSearchParams({ teamId });
  if (options.includeData !== undefined) {
    query.set("includeData", String(options.includeData));
  }

  return await fetch(
    `${config.EXTRACT_V3_BETA_URL}/internal/threads/${encodeURIComponent(threadId)}?${query}`,
    {
      headers: {
        Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
      },
    },
  );
}

export async function agentThreadController(
  req: RequestWithAuth<{ threadId: string }, AgentThreadResponse, any>,
  res: Response<AgentThreadResponse>,
) {
  const logger = _logger.child({
    threadId: req.params.threadId,
    teamId: req.auth.team_id,
    team_id: req.auth.team_id,
    module: "api/v2",
    method: "agentThreadController",
  });

  const upstream = await fetchAgentThread(
    req.params.threadId,
    req.auth.team_id,
    { includeData: req.query.includeData === "true" },
  );

  if (upstream.status !== 200) {
    const mapped = threadErrorFor(upstream.status);

    if (!mapped) {
      logger.error("Failed to get agent thread.", {
        status: upstream.status,
        text: await upstream.text(),
      });

      return res.status(500).json({
        success: false,
        error: "Failed to get agent thread.",
      });
    }

    return res.status(upstream.status).json({
      success: false,
      code: mapped.code,
      error: mapped.error,
    });
  }

  const body = (await upstream.json()) as { thread?: AgentThread };

  return res.status(200).json({
    success: true,
    // The agent service may return the thread bare or already wrapped.
    thread: (body.thread ?? body) as AgentThread,
  });
}
