import type { Request, Response } from "express";
import { logger } from "./logger";

const FIRECRAWL_INTEGRATIONS_ORIGIN = "https://integrations.firecrawl.dev";
const DEFAULT_PROXY_TIMEOUT_MS = 60_000;

/** Partner route for POST /admin/integration/rotate-api-key */
const PARTNER_ROTATE_UPSTREAM_PATH = "/partner/v1/api-keys/rotate";

/**
 * Same contract as firecrawl-integrations `ResponseErrorPayload` (`src/errors/response-error.ts`).
 * Allowed `error.code` values are the `ExternalErrorCode` union in `src/errors/service-error.ts`;
 * those files are the source of truth (no separate public error-code doc today).
 */
type IntegrationsResponseErrorPayload = {
  error: {
    code: string;
    message: string;
    data?: unknown;
  };
};

/**
 * Proxies POST `/admin/integration/rotate-api-key` to `https://integrations.firecrawl.dev`.
 * JSON responses (success or error) are passed through with the upstream status. Upstream errors follow
 * firecrawl-integrations `ResponseErrorPayload` (`error: { code, message, data? }`).
 */
export async function handleIntegrationAdminRotateProxy(
  req: Request,
  res: Response,
): Promise<void> {
  const url = `${FIRECRAWL_INTEGRATIONS_ORIGIN}${PARTNER_ROTATE_UPSTREAM_PATH}`;
  const log = logger.child({
    module: "admin-integration-integrations-proxy",
    route: "rotate-api-key",
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (req.headers.authorization) {
    headers.authorization = req.headers.authorization;
  }

  let body: string;
  try {
    body = JSON.stringify(req.body ?? {});
  } catch {
    const invalidBody: IntegrationsResponseErrorPayload = {
      error: {
        code: "invalid_request_body",
        message: "Invalid request body",
      },
    };
    res.status(400).json(invalidBody);
    return;
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(DEFAULT_PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    log.error("firecrawl-integrations proxy fetch failed", { error, url });
    const unavailable: IntegrationsResponseErrorPayload = {
      error: {
        code: "unknown_error",
        message: "Integration service unavailable",
      },
    };
    res.status(502).json(unavailable);
    return;
  }

  const text = await upstream.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    res
      .status(upstream.status)
      .type(upstream.headers.get("content-type") ?? "text/plain")
      .send(text);
    return;
  }

  if (parsed !== null && typeof parsed === "object") {
    res.status(upstream.status).json(parsed);
    return;
  }

  res.status(upstream.status).send(text);
}
