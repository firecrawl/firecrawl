import type { MonitorCheckRow, MonitorRow } from "../monitoring/types";
import { createInAppNotification } from "./in_app";
import { shouldSuppressForNoise } from "./monitoring_slack";

function countPhrase(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

/** "3 pages changed, 1 new page." or null when nothing changed. */
export function describeMonitorActivity(
  check: Pick<MonitorCheckRow, "changed_count" | "new_count" | "removed_count">,
): string | null {
  const parts: string[] = [];
  if (check.changed_count > 0) {
    parts.push(`${countPhrase(check.changed_count, "page", "pages")} changed`);
  }
  if (check.new_count > 0) {
    parts.push(countPhrase(check.new_count, "new page", "new pages"));
  }
  if (check.removed_count > 0) {
    parts.push(`${countPhrase(check.removed_count, "page", "pages")} removed`);
  }
  if (parts.length === 0) return null;
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export async function recordMonitorInAppNotification(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  pages: {
    url: string;
    status: string;
    judgment?: {
      meaningful: boolean;
      confidence: "high" | "medium" | "low";
      reason: string;
    } | null;
  }[];
}): Promise<{ attempted: boolean; success: boolean; suppressed?: boolean }> {
  const summary = describeMonitorActivity(params.check);
  if (!summary) return { attempted: false, success: true };
  // Same judge gate as email and Slack, so the bell never fires on noise alone.
  if (shouldSuppressForNoise(params.monitor, params.check, params.pages)) {
    return { attempted: false, success: true, suppressed: true };
  }
  const success = await createInAppNotification(
    params.monitor.team_id,
    "monitorChangeDetected",
    {
      monitorId: params.monitor.id,
      monitorName: params.monitor.name,
      checkId: params.check.id,
      summary,
    },
  );
  return { attempted: true, success };
}
