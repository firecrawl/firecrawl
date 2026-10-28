import type { ApiJobAccess } from "./job-access-store";

type AgentJobExpiry = {
  /** When the run's result stops being served. */
  expiresAtMs: number;
  /** A finished ZDR run past its retention. */
  zeroDataRetentionExpired: boolean;
};

/**
 * When an agent run's result stops being served. A ZDR run is kept for the
 * retention recorded on its job access row when it started, counted from when
 * it finished, and never past the row itself. Until it finishes, the earliest
 * possible deadline is reported: its retention from now. Runs without a
 * recorded retention (non-ZDR runs, and rows written before it was recorded)
 * keep the row's expiry.
 */
export function agentJobExpiry(
  access: Pick<ApiJobAccess, "expiresAtMs" | "zeroDataRetentionMinutes">,
  completedAt: string | undefined,
  now = Date.now(),
): AgentJobExpiry {
  if (access.zeroDataRetentionMinutes === undefined) {
    return { expiresAtMs: access.expiresAtMs, zeroDataRetentionExpired: false };
  }
  const retentionMs = access.zeroDataRetentionMinutes * 60 * 1000;
  const completedAtMs =
    completedAt === undefined ? NaN : Date.parse(completedAt);
  const deadlineMs = Number.isFinite(completedAtMs)
    ? completedAtMs + retentionMs
    : now + retentionMs;
  return {
    expiresAtMs: Math.min(deadlineMs, access.expiresAtMs),
    zeroDataRetentionExpired:
      Number.isFinite(completedAtMs) && now >= deadlineMs,
  };
}

export const ZDR_EXPIRED_ERROR =
  "This run used zero data retention; its result has expired";
