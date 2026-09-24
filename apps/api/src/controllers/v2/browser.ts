import { Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { RequestWithAuth } from "./types";
import { integrationSchema } from "../../utils/integration";
import { isAgentInteropSecretValid } from "../../lib/agent-interop";
import {
  getBrowserSession,
  listBrowserSessions,
  updateBrowserSessionActivity,
} from "../../lib/browser-sessions";
import {
  createBrowserSession,
  browserSessionLinks,
  stopBrowserSession,
  settleBrowserSession,
} from "../../lib/browser-lifecycle";
import {
  executeHangarBrowser,
  getHangarBrowser,
  HangarError,
} from "../../lib/hangar";
import { enqueueBrowserSessionActivity } from "../../lib/browser-session-activity";

export const browserCreateRequestSchema = z.object({
  ttl: z.number().int().min(30).max(3600).default(600),
  activityTtl: z.number().int().min(10).max(3600).default(300),
  streamWebView: z.boolean().default(true),
  recordSession: z.boolean().default(true),
  integration: integrationSchema.optional().transform(value => value || null),
  profile: z
    .object({
      name: z.string().min(1).max(128),
      saveChanges: z.boolean().default(true),
    })
    .optional(),
  __agentInterop: z
    .object({
      auth: z.string(),
      requestId: z.string().uuid(),
      shouldBill: z.boolean(),
    })
    .optional(),
});

const browserExecuteRequestSchema = z.object({
  code: z
    .string()
    .min(1)
    .refine(
      value => Buffer.byteLength(value, "utf8") <= 100_000,
      "Code must not exceed 100,000 UTF-8 bytes.",
    ),
  language: z.enum(["python", "node", "bash"]).default("node"),
  timeout: z.number().int().min(1).max(300).default(30),
  origin: z.string().optional(),
});

export function browserError(res: Response, error: unknown) {
  return res
    .status(error instanceof HangarError ? error.status : 502)
    .json({
      success: false,
      error:
        error instanceof HangarError
          ? error.message
          : "Browser operation failed.",
    });
}

export async function browserCreateController(
  req: RequestWithAuth<{}, any, any>,
  res: Response,
) {
  const body = browserCreateRequestSchema.parse(req.body);
  req.body = body;
  if (
    body.__agentInterop &&
    (!config.AGENT_INTEROP_SECRET ||
      !isAgentInteropSecretValid(body.__agentInterop.auth))
  ) {
    return res
      .status(403)
      .json({ success: false, error: "Invalid agent interop." });
  }
  try {
    const { session, expiresAt } = await createBrowserSession(req, {
      ...body,
      shouldBill: body.__agentInterop?.shouldBill,
      requestId: body.__agentInterop?.requestId,
    });
    return res.json({
      success: true,
      id: session.id,
      ...browserSessionLinks(session),
      expiresAt,
    });
  } catch (error) {
    return browserError(res, error);
  }
}

export async function resolveBrowserSession(
  req: RequestWithAuth<{ sessionId: string }, any, any>,
  res: Response,
) {
  const session = await getBrowserSession(req.params.sessionId);
  if (!session) {
    res
      .status(404)
      .json({ success: false, error: "Browser session not found." });
    return;
  }
  if (session.team_id !== req.auth.team_id) {
    res.status(403).json({ success: false, error: "Forbidden." });
    return;
  }
  return session;
}

export async function browserExecuteController(
  req: RequestWithAuth<{ sessionId: string }, any, any>,
  res: Response,
) {
  const body = browserExecuteRequestSchema.parse(req.body);
  const session = await resolveBrowserSession(req, res);
  if (!session) return;
  if (session.status === "destroyed")
    return res
      .status(410)
      .json({ success: false, error: "Browser session has been destroyed." });
  try {
    const result = await executeHangarBrowser(session.browser_id, body);
    updateBrowserSessionActivity(session.id).catch(() => {});
    enqueueBrowserSessionActivity({
      team_id: req.auth.team_id,
      session_id: session.id,
      source: "browser",
      language: body.language,
      timeout: body.timeout,
      exit_code: result.exitCode,
      killed: result.killed,
    });
    return res.json({
      success: true,
      ...result,
      ...(result.exitCode !== 0 || result.killed
        ? { error: result.stderr || "Execution failed" }
        : {}),
    });
  } catch (error) {
    return browserError(res, error);
  }
}

export async function browserDeleteController(
  req: RequestWithAuth<{ sessionId: string }, any, any>,
  res: Response,
) {
  const session = await resolveBrowserSession(req, res);
  if (!session) return;
  try {
    return res.json(await stopBrowserSession(session));
  } catch (error) {
    return browserError(res, error);
  }
}

export async function browserStatusController(
  req: RequestWithAuth<{ sessionId: string }, any, any>,
  res: Response,
) {
  const session = await resolveBrowserSession(req, res);
  if (!session) return;
  try {
    const browser = await getHangarBrowser(session.browser_id);
    const billing = await settleBrowserSession(session, browser);
    return res.json({
      success: true,
      id: session.id,
      status: browser.status,
      ...browserSessionLinks(session),
      ...billing,
      error: browser.error ?? undefined,
    });
  } catch (error) {
    return browserError(res, error);
  }
}

export async function browserListController(
  req: RequestWithAuth<{}, any, any>,
  res: Response,
) {
  const status = z
    .enum(["active", "destroyed", "error"])
    .optional()
    .parse(req.query.status);
  const sessions = await listBrowserSessions(req.auth.team_id, { status });
  return res.json({
    success: true,
    sessions: sessions.map(session => ({
      id: session.id,
      status: session.status,
      ...browserSessionLinks(session),
      streamWebView: session.stream_web_view,
      createdAt: session.created_at,
      lastActivity: session.updated_at,
    })),
  });
}

export async function browserReplayController(
  req: RequestWithAuth<{ sessionId: string }, any, any>,
  res: Response,
) {
  const session = await resolveBrowserSession(req, res);
  if (!session) return;
  if (!session.context_id)
    return res.status(404).json({ success: false, error: "Replay not found." });
  return res.json({ success: true, playlistUrl: session.context_id });
}
