import { config } from "../../config";
import { logger as _logger } from "../logger";
import { sendAzureSentinelEvents } from "./azure-sentinel";
import {
  siemAuditBufferedEvents,
  siemAuditDeliveryBatchesTotal,
  siemAuditDeliveryFailuresTotal,
  siemAuditEventsTotal,
} from "./metrics";
import {
  SiemDeliveryError,
  type AzureSentinelDestination,
  type ScrapeActivityEvent,
} from "./types";

const logger = _logger.child({ module: "siem-audit-buffer" });

type Deliver = (
  destination: AzureSentinelDestination,
  events: ScrapeActivityEvent[],
) => Promise<void>;

export class SiemAuditBuffer {
  private events: ScrapeActivityEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private destination: AzureSentinelDestination,
    private readonly deliver: Deliver = sendAzureSentinelEvents,
    private readonly maxEvents = config.SIEM_AUDIT_BUFFER_MAX_EVENTS,
    private readonly maxBatchEvents = config.SIEM_AUDIT_BATCH_MAX_EVENTS,
    private readonly flushIntervalMs = config.SIEM_AUDIT_FLUSH_INTERVAL_MS,
    private readonly onIdle?: () => void,
    private readonly onBatchSettled?: (eventCount: number) => void,
  ) {}

  updateDestination(destination: AzureSentinelDestination): void {
    this.destination = destination;
  }

  get size(): number {
    return this.events.length;
  }

  enqueue(event: ScrapeActivityEvent): boolean {
    if (this.events.length >= this.maxEvents) {
      siemAuditEventsTotal.inc({ result: "dropped_buffer_full" });
      siemAuditDeliveryFailuresTotal.inc({ reason: "buffer_full" });
      logger.error("SIEM audit buffer is full; dropping event", {
        orgId: event.org_id,
        scrapeId: event.scrape_id,
        bufferedEvents: this.events.length,
      });
      return false;
    }

    this.events.push(event);
    siemAuditBufferedEvents.inc();
    siemAuditEventsTotal.inc({ result: "buffered" });

    if (this.events.length >= this.maxBatchEvents) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
    return true;
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.events.length === 0) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const batch = this.events.splice(0, this.maxBatchEvents);
    siemAuditBufferedEvents.dec(batch.length);
    const destination = this.destination;
    this.flushing = this.deliver(destination, batch)
      .then(() => {
        siemAuditDeliveryBatchesTotal.inc({ result: "success" });
      })
      .catch(error => {
        const reason =
          error instanceof SiemDeliveryError ? error.kind : "delivery_error";
        siemAuditDeliveryBatchesTotal.inc({ result: "failure" });
        siemAuditDeliveryFailuresTotal.inc({ reason });
        logger.error("SIEM audit batch delivery failed", {
          error,
          eventCount: batch.length,
          reason,
        });
      })
      .finally(() => {
        this.onBatchSettled?.(batch.length);
        this.flushing = null;
        if (this.events.length > 0) {
          if (this.events.length >= this.maxBatchEvents) void this.flush();
          else this.scheduleFlush();
        } else {
          this.onIdle?.();
        }
      });
    return this.flushing;
  }

  dispose(): number {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const discarded = this.events.length;
    if (this.events.length > 0) {
      siemAuditBufferedEvents.dec(this.events.length);
      this.events = [];
    }
    return discarded;
  }
}

const buffers = new Map<string, SiemAuditBuffer>();
let pendingGlobalEvents = 0;

export function enqueueForSiemDelivery(
  orgId: string,
  destination: AzureSentinelDestination,
  event: ScrapeActivityEvent,
): boolean {
  if (pendingGlobalEvents >= config.SIEM_AUDIT_BUFFER_MAX_EVENTS) {
    siemAuditEventsTotal.inc({ result: "dropped_buffer_full" });
    siemAuditDeliveryFailuresTotal.inc({ reason: "buffer_full" });
    logger.error("SIEM audit process buffer is full; dropping event", {
      orgId,
      scrapeId: event.scrape_id,
      pendingEvents: pendingGlobalEvents,
    });
    return false;
  }

  let buffer = buffers.get(orgId);
  if (!buffer) {
    const created = new SiemAuditBuffer(
      destination,
      sendAzureSentinelEvents,
      config.SIEM_AUDIT_BUFFER_MAX_EVENTS,
      config.SIEM_AUDIT_BATCH_MAX_EVENTS,
      config.SIEM_AUDIT_FLUSH_INTERVAL_MS,
      () => {
        if (buffers.get(orgId) === created && created.size === 0) {
          buffers.delete(orgId);
        }
      },
      eventCount => {
        pendingGlobalEvents = Math.max(0, pendingGlobalEvents - eventCount);
      },
    );
    buffer = created;
    buffers.set(orgId, buffer);
  } else {
    buffer.updateDestination(destination);
  }
  const accepted = buffer.enqueue(event);
  if (accepted) pendingGlobalEvents++;
  return accepted;
}

export function clearSiemAuditBuffers(): void {
  for (const buffer of buffers.values()) {
    pendingGlobalEvents = Math.max(0, pendingGlobalEvents - buffer.dispose());
  }
  buffers.clear();
}
