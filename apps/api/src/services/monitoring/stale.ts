import type { MonitorCheckRow } from "./types";

export const MONITOR_CHECK_STALE_TIMEOUT_MS = 60 * 60 * 1000;
// Search checks run inline and finish in minutes; a stranded one should self-heal quickly, not look dead for an hour.
const MONITOR_SEARCH_CHECK_STALE_TIMEOUT_MS = 10 * 60 * 1000;
export const MONITOR_CHECK_STALE_ERROR =
  "Monitor check exceeded the running timeout.";

function allEntriesSearch(entries: unknown): boolean {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.every(
    e =>
      e != null &&
      typeof e === "object" &&
      (e as { type?: unknown }).type === "search",
  );
}

// Short timeout only when EVERY target is search. Prefer the monitor's configured
// targets so queued checks (empty target_results) still get it; fall back to target_results.
function isSearchOnlyCheck(
  check: { target_results?: unknown },
  monitorTargets?: unknown,
): boolean {
  if (Array.isArray(monitorTargets)) return allEntriesSearch(monitorTargets);
  return allEntriesSearch(check.target_results);
}

export function monitorCheckStaleTimeoutMs(
  check: {
    target_results?: unknown;
  },
  monitorTargets?: unknown,
): number {
  return isSearchOnlyCheck(check, monitorTargets)
    ? MONITOR_SEARCH_CHECK_STALE_TIMEOUT_MS
    : MONITOR_CHECK_STALE_TIMEOUT_MS;
}

export function isMonitorCheckStale(
  check: Pick<MonitorCheckRow, "started_at" | "updated_at" | "created_at"> & {
    target_results?: unknown;
  },
  now: Date = new Date(),
  monitorTargets?: unknown,
): boolean {
  const startedAt = check.started_at ?? check.updated_at ?? check.created_at;
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return false;
  return (
    now.getTime() - startedAtMs >=
    monitorCheckStaleTimeoutMs(check, monitorTargets)
  );
}
