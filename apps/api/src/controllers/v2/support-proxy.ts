import { Request, Response } from "express";
import { config } from "../../config";
import { logger } from "../../lib/logger";

const SUPPORT_AGENT_BASE = config.SUPPORT_AGENT_URL;
const SUPPORT_AGENT_BYPASS = config.SUPPORT_AGENT_VERCEL_BYPASS_SECRET;
const PROXY_TIMEOUT_MS = 65_000;

const FORWARDED_HEADERS = [
  "authorization",
  "idempotency-key",
  "x-request-id",
];

export async function supportProxyController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!SUPPORT_AGENT_BASE) {
    res.status(503).json({ error: "support_agent_unavailable" });
    return;
  }

  const target = `${SUPPORT_AGENT_BASE}/api/v2${req.path}`;

  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") {
      headers[name] = value;
    }
  }

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        ...(SUPPORT_AGENT_BYPASS && {
          "x-vercel-protection-bypass": SUPPORT_AGENT_BYPASS,
        }),
      },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });

    for (const name of ["content-type", "x-request-id", "x-idempotency-cached"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    res.status(upstream.status);
    const body = await upstream.text();
    res.send(body);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      logger.error("Support agent proxy timeout");
      res.status(504).json({ error: "support_agent_timeout" });
      return;
    }
    logger.error("Support agent proxy error", { error: err });
    res.status(502).json({ error: "support_agent_unreachable" });
  }
}
