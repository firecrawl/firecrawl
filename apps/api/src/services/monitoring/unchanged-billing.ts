import { autumnService } from "../autumn/autumn.service";
import { validateMonitorCron } from "./cron";

export function unchangedPagesFreeForInterval(
  intervalMs: number,
  thresholdMinutes: number,
): boolean {
  return intervalMs >= thresholdMinutes * 60 * 1000;
}

/**
 * Whether this monitor's checks bill unchanged ("same") pages. Plan-gated:
 * eligible only when the schedule interval is at or above the team's Autumn
 * MONITOR_UNCHANGED_MIN_THRESHOLD grant (config default when ungranted).
 * Eligibility is a discount, so any failure resolves to false — billing stays
 * at the status quo rather than under-charging.
 */
export async function monitorUnchangedPagesFree(monitor: {
  team_id: string;
  schedule_cron: string;
  schedule_timezone: string;
}): Promise<boolean> {
  try {
    const { intervalMs } = validateMonitorCron(
      monitor.schedule_cron,
      monitor.schedule_timezone,
    );
    const thresholdMinutes =
      await autumnService.getMonitorUnchangedFreeMinIntervalMinutes(
        monitor.team_id,
      );
    return unchangedPagesFreeForInterval(intervalMs, thresholdMinutes);
  } catch {
    return false;
  }
}
