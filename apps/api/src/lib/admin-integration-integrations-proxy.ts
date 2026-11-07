import type { Request, Response } from "express";
import { logger } from "./logger";

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

async function proxyPartnerIntegrationPost(
  req: Request,
  res: Response,
  upstreamPath:
    | "/partner/v1/accounts"
    | "/partner/v1/api-keys/validate"
    | "/partner/v1/api-keys/rotate",
  route: "create-user" | "validate-api-key" | "rotate-api-key",
): Promise<void> {
  const url = `https://integrations.firecrawl.dev${upstreamPath}`;
  const log = logger.child({
    module: "admin-integration-integrations-proxy",
    route,
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
      signal: AbortSignal.timeout(60_000),
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

/**
 * Proxies POST `/admin/integration/create-user` to integrations
 * `POST /partner/v1/accounts`. JSON responses pass through with upstream status.
 */
export async function handleIntegrationAdminCreateUserProxy(
  req: Request,
  res: Response,
): Promise<void> {
  await proxyPartnerIntegrationPost(
    req,
    res,
    "/partner/v1/accounts",
    "create-user",
  );
}

/**
 * Proxies POST `/admin/integration/validate-api-key` to integrations
 * `POST /partner/v1/api-keys/validate`. JSON responses pass through with upstream status.
 */
export async function handleIntegrationAdminValidateProxy(
  req: Request,
  res: Response,
): Promise<void> {
  await proxyPartnerIntegrationPost(
    req,
    res,
    "/partner/v1/api-keys/validate",
    "validate-api-key",
  );
}

/**
 * Proxies POST `/admin/integration/rotate-api-key` to integrations
 * `POST /partner/v1/api-keys/rotate`. JSON responses pass through with upstream status.
 */
export async function handleIntegrationAdminRotateProxy(
  req: Request,
  res: Response,
): Promise<void> {
  await proxyPartnerIntegrationPost(
    req,
    res,
    "/partner/v1/api-keys/rotate",
    "rotate-api-key",
  );
}
