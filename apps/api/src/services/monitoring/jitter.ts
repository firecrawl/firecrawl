import { createHash } from "crypto";

const MAX_JITTER_MS = 5 * 60 * 1000;

export function monitorJitterOffsetMs(
  monitorId: string,
  intervalMs: number,
): number {
  const jitterMaxMs = Math.min(Math.floor(intervalMs / 2), MAX_JITTER_MS);
  if (jitterMaxMs <= 0) return 0;
  const hash = createHash("sha256").update(monitorId).digest();
  return hash.readUInt32BE(0) % jitterMaxMs;
}
