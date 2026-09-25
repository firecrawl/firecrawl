import {
  getSafeMode,
  SAFE_MODE_BROWSER_UNSUPPORTED_MESSAGE,
} from "../../lib/safe-mode";
import { deleteBrowserProfile } from "../../lib/browser-sessions";
import { deleteHangarProfile } from "../../lib/hangar";
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
  getHangarRecording,
  HangarError,
} from "../../lib/hangar";
import { enqueueBrowserSessionActivity } from "../../lib/browser-session-activity";
import { browserProfileNameSchema } from "../../lib/browser-profiles";

export const browserCreateRequestSchema = z.object({
  ttl: z.number().int().min(30).max(3600).default(600),
  activityTtl: z.number().int().min(10).max(3600).default(300),
  streamWebView: z.boolean().default(true),
  recordSession: z.boolean().default(true),
  integration: integrationSchema.optional().transform(value => value || null),
  profile: z
    .object({
      name: browserProfileNameSchema,
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
  return res.status(error instanceof HangarError ? error.status : 502).json({
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
  if (getSafeMode(req.acuc?.flags)) {
    return res
      .status(403)
      .json({ success: false, error: SAFE_MODE_BROWSER_UNSUPPORTED_MESSAGE });
  }
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

async function resolveBrowserSession(
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
  if (getSafeMode(req.acuc?.flags)) {
    return res
      .status(403)
      .json({ success: false, error: SAFE_MODE_BROWSER_UNSUPPORTED_MESSAGE });
  }
  const session = await resolveBrowserSession(req, res);
  if (!session) return;
  if (session.status === "destroyed")
    return res
      .status(410)
      .json({ success: false, error: "Browser session has been destroyed." });
  try {
    updateBrowserSessionActivity(session.id).catch(() => {});
    const result = await executeHangarBrowser(session.browser_id, body);
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

// DELETE /v2/browser/profiles/:name
// Deletes a persistent profile's saved state and its listing. Deleting a
// profile that has no saved state succeeds.
export async function browserProfileDeleteController(
  req: RequestWithAuth<{ name: string }, { success: boolean; error?: string }>,
  res: Response<{ success: boolean; error?: string }>,
) {
  if (getSafeMode(req.acuc?.flags)) {
    return res
      .status(403)
      .json({ success: false, error: SAFE_MODE_BROWSER_UNSUPPORTED_MESSAGE });
  }
  const name = browserProfileNameSchema.safeParse(req.params.name);
  if (!name.success) {
    return res.status(400).json({
      success: false,
      error: "Profile name must be between 1 and 128 UTF-8 bytes.",
    });
  }
  try {
    const { deletedAt } = await deleteHangarProfile(
      req.auth.team_id,
      name.data,
    );
    await deleteBrowserProfile(req.auth.team_id, name.data, deletedAt);
    return res.json({ success: true });
  } catch (error) {
    if (error instanceof HangarError && error.status === 409) {
      return res.status(409).json({
        success: false,
        error:
          "A session is currently saving to this profile. Stop that session, then delete the profile.",
      });
    }
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
  try {
    const recording = await getHangarRecording(session.context_id);
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      success: true,
      pages: [
        {
          pageId: "0",
          url: `/v2/interact/${encodeURIComponent(session.id)}/replay/0`,
          // The desktop stream spans tabs and has no single page URL.
          pageUrl: "",
          startTimeMs: 0,
          endTimeMs: recording.durationMs,
        },
      ],
      pageCount: 1,
    });
  } catch (error) {
    return browserError(res, error);
  }
}

export async function browserReplayPageController(
  req: RequestWithAuth<{ sessionId: string; pageId: string }, any, any>,
  res: Response,
) {
  if (!/^\d{1,3}$/.test(req.params.pageId))
    return res.status(400).json({ success: false, error: "Invalid pageId." });
  const session = await resolveBrowserSession(req, res);
  if (!session) return;
  if (req.params.pageId !== "0" || !session.context_id)
    return res.status(404).json({ success: false, error: "Replay not found." });
  try {
    const recording = await getHangarRecording(session.context_id);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(recording.playlist);
  } catch (error) {
    return browserError(res, error);
  }
}
