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
  deliver: (
    destination: AzureSentinelDestination,
    events: ScrapeActivityEvent[],
  ) => Promise<void>;
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
    await deps.deliver(config.destination, events);
    siemLoggingEventsTotal.inc({ result: "delivered" }, events.length);
    return { disposition: "done" };
  } catch (error) {
    const reason =
      error instanceof SiemDeliveryError ? error.kind : "delivery_error";
    siemLoggingEventsTotal.inc({ result: "delivery_failed" }, events.length);
    siemLoggingDeliveryFailuresTotal.inc({ reason }, events.length);
    logger.error("SIEM logging batch delivery failed", {
      error,
      reason,
      events: events.length,
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
