import { JOB_ACCESS_TTL_MS, type ApiJobAccess } from "./job-access-store";

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
 * possible deadline is reported: its retention from now. A finished run whose
 * completion time is missing counts from when it started (the row is written
 * then, with the default TTL), which never overstates the deadline; the agent
 * service still enforces the real one. Runs without a recorded retention
 * (non-ZDR runs, and rows written before it was recorded) keep the row's
 * expiry.
 */
export function agentJobExpiry(
  access: Pick<ApiJobAccess, "expiresAtMs" | "zeroDataRetentionMinutes">,
  agent: { status: "processing" | "success" | "failed"; completedAt?: string },
  now = Date.now(),
): AgentJobExpiry {
  if (access.zeroDataRetentionMinutes === undefined) {
    return { expiresAtMs: access.expiresAtMs, zeroDataRetentionExpired: false };
  }
  const retentionMs = access.zeroDataRetentionMinutes * 60 * 1000;
  if (agent.status === "processing") {
    return {
      expiresAtMs: Math.min(now + retentionMs, access.expiresAtMs),
      zeroDataRetentionExpired: false,
    };
  }
  const completedAtMs =
    agent.completedAt === undefined ? NaN : Date.parse(agent.completedAt);
  if (!Number.isFinite(completedAtMs)) {
    return {
      expiresAtMs: Math.min(
        access.expiresAtMs - JOB_ACCESS_TTL_MS + retentionMs,
        access.expiresAtMs,
      ),
      zeroDataRetentionExpired: false,
    };
  }
  const deadlineMs = completedAtMs + retentionMs;
  return {
    expiresAtMs: Math.min(deadlineMs, access.expiresAtMs),
    zeroDataRetentionExpired: now >= deadlineMs,
  };
}

export const ZDR_EXPIRED_ERROR =
  "This run used zero data retention; its result has expired";
