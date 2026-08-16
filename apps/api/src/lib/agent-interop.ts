import { timingSafeEqual } from "node:crypto";
import { config } from "../config";

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
