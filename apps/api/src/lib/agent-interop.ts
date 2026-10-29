import { timingSafeEqual } from "node:crypto";
import { config } from "../config";

// Header form of `__agentInterop.auth`, for calls with no JSON body (DELETE, GET).
export const AGENT_INTEROP_HEADER = "x-firecrawl-agent-interop";

export function isAgentInteropSecretValid(provided: unknown): boolean {
  const expected = config.AGENT_INTEROP_SECRET;
  if (
    typeof provided !== "string" ||
    !expected ||
    expected.trim().length === 0
  ) {
    return false;
  }

  const providedBuffer = Buffer.from(provided, "utf16le");
  const expectedBuffer = Buffer.from(expected, "utf16le");
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export type AgentInteropStatus = "trusted" | "none" | "invalid";

/**
 * Agent-interop standing of the raw request (auth runs before any controller
 * re-parses the body). Each place a secret can be sent (the `__agentInterop`
 * block, AGENT_INTEROP_HEADER) that is present must hold the valid secret:
 * `trusted` needs at least one and no wrong one, `none` means neither is sent.
 */
export function agentInteropStatus(req: {
  body?: any;
  headers?: Record<string, unknown>;
}): AgentInteropStatus {
  const provided: unknown[] = [];
  if (req.body?.__agentInterop != null)
    provided.push(req.body.__agentInterop.auth);
  const headerAuth = req.headers?.[AGENT_INTEROP_HEADER];
  if (headerAuth !== undefined) provided.push(headerAuth);
  if (provided.length === 0) return "none";
  return provided.every(isAgentInteropSecretValid) ? "trusted" : "invalid";
}

/** Presence of the block or header alone is never trusted; only the secret. */
export function isTrustedAgentInteropRequest(req: {
  body?: any;
  headers?: Record<string, unknown>;
}): boolean {
  return agentInteropStatus(req) === "trusted";
}
