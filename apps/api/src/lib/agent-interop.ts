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

/**
 * Whether the request carries a valid agent-interop secret, i.e. comes from
 * the trusted internal agent service. Read from the raw body (auth runs before
 * the controller's zod parse) or, for bodiless calls, from AGENT_INTEROP_HEADER.
 * Presence of the block or header alone is never trusted; only the secret.
 */
export function isTrustedAgentInteropRequest(req: {
  body?: any;
  headers?: Record<string, unknown>;
}): boolean {
  return (
    isAgentInteropSecretValid(req.body?.__agentInterop?.auth) ||
    isAgentInteropSecretValid(req.headers?.[AGENT_INTEROP_HEADER])
  );
}
