import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

// Compares SHA-256 digests so neither content nor length leaks through timing.
export function timingSafeSecretEqual(
  provided: unknown,
  expected?: string,
): boolean {
  if (typeof provided !== "string" || !provided || !expected) {
    return false;
  }
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

type ProxySecretHeaders =
  | IncomingHttpHeaders
  | {
      "x-firecrawl-hosted-mcp-secret"?: unknown;
      "x-firecrawl-keyless-secret"?: unknown;
    };

export function hasHostedMcpProxySecret(
  headers: ProxySecretHeaders,
  secrets: {
    HOSTED_MCP_PROXY_SECRET?: string;
    KEYLESS_PROXY_SECRET?: string;
  },
): boolean {
  return (
    timingSafeSecretEqual(
      headers["x-firecrawl-hosted-mcp-secret"],
      secrets.HOSTED_MCP_PROXY_SECRET,
    ) ||
    timingSafeSecretEqual(
      headers["x-firecrawl-keyless-secret"],
      secrets.KEYLESS_PROXY_SECRET,
    )
  );
}
