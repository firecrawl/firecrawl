import { sendAzureSentinelEvents } from "../../lib/siem-logging/azure-sentinel";
import {
  siemLoggingDeliveryFailuresTotal,
  siemLoggingEventsTotal,
} from "../../lib/siem-logging/metrics";
import { getOrgSiemLoggingConfig } from "../../lib/siem-logging/store";
import {
  consumeSiemLoggingEvents,
  type SiemLoggingBatchOutcome,
} from "../../lib/siem-logging/transport";
import {
  SiemDeliveryError,
  type AzureSentinelDestination,
  type OrgSiemLoggingConfig,
  type ScrapeActivityEvent,
} from "../../lib/siem-logging/types";
import { logger as _logger } from "../../lib/logger";

interface HandlerDependencies {
  getConfig: (orgId: string) => Promise<OrgSiemLoggingConfig | null>;
  /** Resolves with the number of events the destination actually accepted. */
  deliver: (
    destination: AzureSentinelDestination,
    events: ScrapeActivityEvent[],
  ) => Promise<number>;
}

const defaultDependencies: HandlerDependencies = {
  // Read the destination at delivery time from the primary, never from the
  // queued message: a rotated secret or a disabled config has to take effect on
  // events that were already in flight.
  getConfig: orgId =>
    getOrgSiemLoggingConfig(orgId, { fresh: true, primary: true }),
  deliver: sendAzureSentinelEvents,
};

const permanentFailureKinds = new Set([
  "invalid_credentials",
  "schema_rejection",
]);

export async function deliverSiemLoggingBatch(
  orgId: string,
  events: ScrapeActivityEvent[],
  deps: HandlerDependencies = defaultDependencies,
): Promise<SiemLoggingBatchOutcome> {
  const logger = _logger.child({ module: "siem-logging-worker", orgId });

  let config: OrgSiemLoggingConfig | null;
  try {
    config = await deps.getConfig(orgId);
  } catch (error) {
    logger.error("Failed to load SIEM logging configuration", { error });
    return { disposition: "retry" };
  }

  if (!config?.enabled) {
    siemLoggingEventsTotal.inc({ result: "skipped_disabled" }, events.length);
    return { disposition: "done" };
  }

  try {
    // Count what the destination took, not what we handed over: the sender skips
    // events it can never deliver, and those are already counted as dropped.
    const delivered = await deps.deliver(config.destination, events);
    if (delivered > 0) {
      siemLoggingEventsTotal.inc({ result: "delivered" }, delivered);
    }
    return { disposition: "done" };
  } catch (error) {
    const reason =
      error instanceof SiemDeliveryError ? error.kind : "delivery_error";
    // A batch goes out as several chunks, so a failure part-way through still
    // left events with the destination. Count those as delivered and only the
    // remainder as failed, or the retry double-counts them.
    const delivered =
      error instanceof SiemDeliveryError ? error.deliveredEvents : 0;
    const failed = Math.max(0, events.length - delivered);
    if (delivered > 0) {
      siemLoggingEventsTotal.inc({ result: "delivered" }, delivered);
    }
    if (failed > 0) {
      siemLoggingEventsTotal.inc({ result: "delivery_failed" }, failed);
      siemLoggingDeliveryFailuresTotal.inc({ reason }, failed);
    }
    logger.error("SIEM logging batch delivery failed", {
      error,
      reason,
      events: events.length,
      deliveredBeforeFailure: delivered,
    });

    if (
      error instanceof SiemDeliveryError &&
      permanentFailureKinds.has(error.kind)
    ) {
      // Bad credentials or a rejected schema will fail identically forever;
      // dead-letter so an operator sees it instead of burning the ladder.
      return { disposition: "drop" };
    }
    return {
      disposition: "retry",
      retryAfterMs:
        error instanceof SiemDeliveryError ? error.retryAfterMs : undefined,
    };
  }
}

export async function startSiemLoggingConsumer(): Promise<void> {
  await consumeSiemLoggingEvents((orgId, events) =>
    deliverSiemLoggingBatch(orgId, events),
  );
}
