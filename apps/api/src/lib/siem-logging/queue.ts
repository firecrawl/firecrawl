import { createHash } from "node:crypto";
import { getSiemLoggingQueue } from "../../services/queue-service";
import { siemLoggingEventsTotal } from "./metrics";
import type { ScrapeActivityEvent, SiemLoggingJobData } from "./types";

function jobIdFor(orgId: string, event: ScrapeActivityEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        orgId,
        event.schema_version,
        event.event_type,
        event.scrape_id,
        event.request_id,
        event.result,
      ]),
    )
    .digest("hex");
}

export async function enqueueSiemLoggingEvent(
  orgId: string,
  event: ScrapeActivityEvent,
): Promise<void> {
  await enqueueSiemLoggingEvents(orgId, [event]);
}

export async function enqueueSiemLoggingEvents(
  orgId: string,
  events: ScrapeActivityEvent[],
): Promise<void> {
  if (events.length === 0) return;
  try {
    await getSiemLoggingQueue().addBulk(
      events.map(event => ({
        name: "deliver",
        data: { orgId, event } satisfies SiemLoggingJobData,
        opts: { jobId: jobIdFor(orgId, event) },
      })),
    );
    siemLoggingEventsTotal.inc({ result: "queued" }, events.length);
  } catch (error) {
    siemLoggingEventsTotal.inc({ result: "enqueue_failed" }, events.length);
    throw error;
  }
}
