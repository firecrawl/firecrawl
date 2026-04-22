import { Response } from "express";
import { fetch } from "undici";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { RequestWithAuth } from "./types";
import {
  registerLocalBrowserSession,
  unregisterLocalBrowserSession,
  checkLocalBrowserOwnership,
} from "../../lib/local-browser-sessions";

interface LocalBrowserCreateResponse {
  success: boolean;
  id?: string;
  cdp_url?: string;
  expires_at?: string;
  error?: string;
}

interface LocalBrowserDeleteResponse {
  success: boolean;
  error?: string;
}

const MICROSERVICE_CREATE_TIMEOUT_MS = 60_000;
const MICROSERVICE_DELETE_TIMEOUT_MS = 30_000;

const createResponseSchema = z.object({
  success: z.boolean().optional(),
  id: z.string(),
  cdp_url: z.string(),
  expires_at: z.string().optional(),
});

function getMicroserviceBaseUrl(): string | null {
  const raw = config.PLAYWRIGHT_MICROSERVICE_URL;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export async function localBrowserCreateController(
  req: RequestWithAuth<{}, LocalBrowserCreateResponse, {}>,
  res: Response<LocalBrowserCreateResponse>,
) {
  const logger = _logger.child({
    module: "api/v2",
    method: "localBrowserCreateController",
    teamId: req.auth.team_id,
  });

  const base = getMicroserviceBaseUrl();
  if (!base) {
    return res.status(400).json({
      success: false,
      error:
        "Local browser sessions are not available: PLAYWRIGHT_MICROSERVICE_URL is not configured.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MICROSERVICE_CREATE_TIMEOUT_MS,
  );

  let upstreamStatus = 0;
  let upstreamBody: string = "";
  try {
    const upstream = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    upstreamStatus = upstream.status;
    upstreamBody = await upstream.text();
  } catch (err) {
    logger.error("Failed to reach playwright microservice", { error: err });
    return res.status(502).json({
      success: false,
      error: "Failed to reach the local browser service.",
    });
  } finally {
    clearTimeout(timeout);
  }

  if (upstreamStatus === 429) {
    return res.status(429).json({
      success: false,
      error:
        "Too many concurrent local browser sessions. Please delete an existing session and retry.",
    });
  }

  if (upstreamStatus < 200 || upstreamStatus >= 300) {
    logger.warn("Playwright microservice returned non-2xx", {
      status: upstreamStatus,
      body: upstreamBody,
    });
    return res.status(502).json({
      success: false,
      error: `Local browser service returned ${upstreamStatus}.`,
    });
  }

  let parsed: z.infer<typeof createResponseSchema>;
  try {
    parsed = createResponseSchema.parse(JSON.parse(upstreamBody));
  } catch (err) {
    logger.warn("Playwright microservice returned unexpected payload", {
      body: upstreamBody,
      error: err,
    });
    return res.status(502).json({
      success: false,
      error: "Local browser service returned an unexpected response.",
    });
  }

  registerLocalBrowserSession(parsed.id, req.auth.team_id);

  logger.info("Created local browser session", { sessionId: parsed.id });

  return res.status(200).json({
    success: true,
    id: parsed.id,
    cdp_url: parsed.cdp_url,
    expires_at: parsed.expires_at,
  });
}

export async function localBrowserDeleteController(
  req: RequestWithAuth<{ id: string }, LocalBrowserDeleteResponse, {}>,
  res: Response<LocalBrowserDeleteResponse>,
) {
  const logger = _logger.child({
    module: "api/v2",
    method: "localBrowserDeleteController",
    teamId: req.auth.team_id,
    sessionId: req.params.id,
  });

  const base = getMicroserviceBaseUrl();
  if (!base) {
    return res.status(400).json({
      success: false,
      error:
        "Local browser sessions are not available: PLAYWRIGHT_MICROSERVICE_URL is not configured.",
    });
  }

  const ownership = checkLocalBrowserOwnership(req.params.id, req.auth.team_id);
  if (ownership.kind === "not-found") {
    return res.status(404).json({
      success: false,
      error: "Local browser session not found.",
    });
  }
  if (ownership.kind === "forbidden") {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MICROSERVICE_DELETE_TIMEOUT_MS,
  );

  let upstreamStatus = 0;
  try {
    const upstream = await fetch(
      `${base}/sessions/${encodeURIComponent(req.params.id)}`,
      {
        method: "DELETE",
        signal: controller.signal,
      },
    );
    upstreamStatus = upstream.status;
  } catch (err) {
    logger.error("Failed to reach playwright microservice", { error: err });
    return res.status(502).json({
      success: false,
      error: "Failed to reach the local browser service.",
    });
  } finally {
    clearTimeout(timeout);
  }

  // Remove local ownership regardless of upstream status: either the session
  // is truly gone (2xx / 404) or the microservice is unreachable and we want
  // the operator to be able to try again without our local map blocking them.
  unregisterLocalBrowserSession(req.params.id);

  if (upstreamStatus === 404) {
    // Upstream is already gone; reflect that as success from the client's POV
    // since local ownership was valid (we checked above). The session has
    // simply been cleaned up (e.g. expired).
    return res.status(200).json({ success: true });
  }

  if (upstreamStatus < 200 || upstreamStatus >= 300) {
    logger.warn("Playwright microservice returned non-2xx on delete", {
      status: upstreamStatus,
    });
    return res.status(502).json({
      success: false,
      error: `Local browser service returned ${upstreamStatus}.`,
    });
  }

  logger.info("Deleted local browser session");
  return res.status(200).json({ success: true });
}
