import { Response } from "express";
import { validate as isUuid } from "uuid";
import { z } from "zod";
import { config } from "../../config";
import { agentJobExpiry, ZDR_EXPIRED_ERROR } from "../../lib/agent-job-expiry";
import {
  agentStatusUnavailable,
  ExtractV3AgentStatusError,
  getExtractV3AgentStatus,
} from "../../lib/extract-v3-status";
import { logger as _logger } from "../../lib/logger";
import { getAgentJobAccess } from "../../lib/operational-job-access";
import { RequestWithAuth } from "./types";

type JobRequest<Body = any> = RequestWithAuth<{ jobId: string }, any, Body>;

const AGENT_JOB_NOT_FOUND = { success: false, error: "Agent job not found" };

// Null once the row expires; the agent service then checks ownership from x-team-id.
async function readOwnedRunAccess(req: JobRequest, res: Response) {
  const access = await getAgentJobAccess(req.params.jobId, req.auth.team_id);
  if (access && access.teamId !== req.auth.team_id) {
    res.status(404).json(AGENT_JOB_NOT_FOUND);
    return false;
  }
  return { access };
}

async function forwardToAgentService(
  req: RequestWithAuth<any, any, any>,
  res: Response,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  const upstream = await fetch(`${config.EXTRACT_V3_BETA_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
      "x-team-id": req.auth.team_id,
      ...(init.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  if (upstream.status >= 500) {
    _logger.error("Agent service request failed.", {
      module: "api/v2",
      method: "forwardToAgentService",
      teamId: req.auth.team_id,
      team_id: req.auth.team_id,
      path: path.split("/").slice(0, 3).join("/"),
      status: upstream.status,
    });
    return res
      .status(500)
      .json({ success: false, error: "Agent service request failed." });
  }

  const text = await upstream.text();
  try {
    return res.status(upstream.status).json(JSON.parse(text));
  } catch {
    return res
      .status(upstream.status)
      .type(upstream.headers.get("content-type") ?? "text/plain")
      .send(text);
  }
}

function jobPath(req: JobRequest, suffix = "") {
  return `/internal/extracts/${encodeURIComponent(req.params.jobId)}${suffix}`;
}

export function agentFeedbackController(kind: "like" | "dislike") {
  return async (req: JobRequest, res: Response) => {
    if (!(await readOwnedRunAccess(req, res))) return;
    return forwardToAgentService(req, res, jobPath(req, `/${kind}`), {
      method: "POST",
    });
  };
}

export async function agentOptionsController(req: JobRequest, res: Response) {
  if (!(await readOwnedRunAccess(req, res))) return;
  return forwardToAgentService(req, res, jobPath(req, "/options"));
}

// Unlike GET /agent/:jobId, this also reads runs past the 24 hour job TTL.
export async function agentResultController(req: JobRequest, res: Response) {
  let owned: Awaited<ReturnType<typeof readOwnedRunAccess>>;
  try {
    owned = await readOwnedRunAccess(req, res);
  } catch {
    return sendAgentStatusError(res, agentStatusUnavailable());
  }
  if (!owned) return;

  let agent: Awaited<ReturnType<typeof getExtractV3AgentStatus>>;
  try {
    agent = await getExtractV3AgentStatus(req.params.jobId, req.auth.team_id);
  } catch (error) {
    if (!(error instanceof ExtractV3AgentStatusError)) throw error;
    return sendAgentStatusError(res, error);
  }

  if (
    owned.access &&
    agentJobExpiry(owned.access, agent).zeroDataRetentionExpired
  ) {
    return res.status(410).json({
      success: false,
      code: "zdr_expired",
      error: ZDR_EXPIRED_ERROR,
    });
  }

  return res.status(200).json(agent);
}

function sendAgentStatusError(res: Response, error: ExtractV3AgentStatusError) {
  if (error.retryAfterSeconds !== undefined) {
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
  }
  return res.status(error.status).json({
    success: false,
    code: error.code,
    error: error.message,
  });
}

const settingsUpdateSchema = z
  .object({
    hidden: z.boolean().optional(),
    starred: z.boolean().optional(),
    label: z.string().nullable().optional(),
  })
  .strict();

export async function agentSettingsController(req: JobRequest, res: Response) {
  let body: z.infer<typeof settingsUpdateSchema> | undefined;
  if (req.method === "PATCH") {
    const parsed = settingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid settings update." });
    }
    body = parsed.data;
  }

  if (!(await readOwnedRunAccess(req, res))) return;
  return forwardToAgentService(req, res, jobPath(req, "/settings"), {
    method: req.method,
    body,
  });
}

export async function agentShareController(req: JobRequest, res: Response) {
  if (!(await readOwnedRunAccess(req, res))) return;
  return forwardToAgentService(req, res, jobPath(req, "/share"), {
    method: req.method,
  });
}

// Share pages are public, so only the dashboard's preview credential may read them.
export async function agentSharedRunController(
  req: RequestWithAuth<{ shareId: string }, any, any>,
  res: Response,
) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const teamId = req.auth.team_id;
  if (teamId !== "preview" && !teamId.startsWith("preview_")) {
    return res.status(403).json({
      success: false,
      error: "Share links are only readable through the dashboard.",
    });
  }
  if (!isUuid(req.params.shareId)) {
    return res.status(400).json({
      success: false,
      error: "Invalid share ID format. Share ID must be a valid UUID.",
    });
  }

  return forwardToAgentService(
    req,
    res,
    `/internal/shares/${encodeURIComponent(req.params.shareId)}`,
  );
}
