import { timingSafeEqual } from "node:crypto";
import { config } from "../config";

export function isAgentInteropSecretValid(provided: unknown): boolean {
  const expected = config.AGENT_INTEROP_SECRET;
  if (typeof provided !== "string" || !expected) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}
