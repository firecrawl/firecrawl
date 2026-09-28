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
