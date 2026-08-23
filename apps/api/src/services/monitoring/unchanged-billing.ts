import { autumnService } from "../autumn/autumn.service";
import { validateMonitorCron } from "./cron";

export function unchangedPagesFreeForInterval(
  intervalMs: number,
  thresholdMinutes: number,
): boolean {
  return intervalMs >= thresholdMinutes * 60 * 1000;
}

/**
 * The team's plan threshold (minutes) for the "unchanged pages are free" rule.
 * Resolve this once per request when serializing several of a team's monitors
 * — `getEntityLimits` only populates its cache once a fetch resolves, so N
 * concurrent per-monitor lookups on a cold cache would each hit Autumn.
 * Null means the threshold could not be resolved, which disqualifies every
 * monitor (see `unchangedPagesFreeForMonitor`).
 */
export async function monitorUnchangedFreeThresholdMinutes(
  teamId: string,
): Promise<number | null> {
  try {
    return await autumnService.getMonitorUnchangedFreeMinIntervalMinutes(
      teamId,
    );
  } catch {
    return null;
  }
}

/**
 * Whether this monitor's checks bill unchanged ("same") pages, given a
 * threshold already resolved by `monitorUnchangedFreeThresholdMinutes`.
 * Eligibility is a discount, so an unresolved threshold or an unparseable
 * schedule resolves to false — billing stays at the status quo rather than
 * under-charging.
 */
export function unchangedPagesFreeForMonitor(
  monitor: {
    schedule_cron: string;
    schedule_timezone: string;
  },
  thresholdMinutes: number | null,
): boolean {
  if (thresholdMinutes === null) return false;
  try {
    const { intervalMs } = validateMonitorCron(
      monitor.schedule_cron,
      monitor.schedule_timezone,
    );
    return unchangedPagesFreeForInterval(intervalMs, thresholdMinutes);
  } catch {
    return false;
  }
}

/**
 * Whether this monitor's checks bill unchanged ("same") pages. Plan-gated:
 * eligible only when the schedule interval is at or above the team's Autumn
 * MONITOR_UNCHANGED_MIN_THRESHOLD grant (config default when ungranted).
 */
export async function monitorUnchangedPagesFree(monitor: {
  team_id: string;
  schedule_cron: string;
  schedule_timezone: string;
}): Promise<boolean> {
  return unchangedPagesFreeForMonitor(
    monitor,
    await monitorUnchangedFreeThresholdMinutes(monitor.team_id),
  );
}
