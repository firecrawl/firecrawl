import type { Job } from "bullmq";
import { config } from "../../config";
import { sendAzureSentinelEvents } from "../../lib/siem-logging/azure-sentinel";
import {
  siemLoggingDeliveryFailuresTotal,
  siemLoggingEventsTotal,
} from "../../lib/siem-logging/metrics";
import { getOrgSiemLoggingConfig } from "../../lib/siem-logging/store";
import {
  SiemDeliveryError,
  type AzureSentinelDestination,
  type OrgSiemLoggingConfig,
  type ScrapeActivityEvent,
  type SiemLoggingJobData,
} from "../../lib/siem-logging/types";
import { logger as _logger } from "../../lib/logger";

interface WorkerDependencies {
  getConfig: (orgId: string) => Promise<OrgSiemLoggingConfig | null>;
  deliver: (
    destination: AzureSentinelDestination,
    events: ScrapeActivityEvent[],
  ) => Promise<void>;
}

const defaultDependencies: WorkerDependencies = {
  getConfig: orgId =>
    getOrgSiemLoggingConfig(orgId, { fresh: true, primary: true }),
  deliver: sendAzureSentinelEvents,
};

const permanentFailureKinds = new Set([
  "invalid_credentials",
  "schema_rejection",
  "payload_too_large",
]);

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function configuredRetryDelay(job: Job<SiemLoggingJobData>): number {
  const backoff = job.opts.backoff;
  if (typeof backoff === "number") return backoff;
  if (!backoff) return 0;
  const delay = backoff.delay ?? 0;
  if (backoff.type === "exponential") {
    return delay * 2 ** job.attemptsMade;
  }
  return delay;
}

function applyRetryAfter(
  job: Job<SiemLoggingJobData>,
  error: SiemDeliveryError,
): void {
  if (
    error.kind !== "rate_limited" ||
    error.retryAfterMs === undefined ||
    error.retryAfterMs <= 0
  ) {
    return;
  }
  job.opts.backoff = {
    type: "fixed",
    delay: Math.max(configuredRetryDelay(job), error.retryAfterMs),
  };
}

export async function processSiemLoggingJob(
  token: string,
  job: Job<SiemLoggingJobData>,
  deps: WorkerDependencies = defaultDependencies,
): Promise<void> {
  const logger = _logger.child({
    module: "siem-logging-worker",
    jobId: job.id,
    orgId: job.data.orgId,
  });
  const extendLockInterval = setInterval(() => {
    void job.extendLock(token, config.JOB_LOCK_EXTENSION_TIME).catch(error => {
      logger.warn("Failed to extend SIEM logging job lock", { error });
    });
  }, config.JOB_LOCK_EXTEND_INTERVAL);
  extendLockInterval.unref?.();

  try {
    const currentConfig = await deps.getConfig(job.data.orgId);
    if (!currentConfig?.enabled) {
      siemLoggingEventsTotal.inc({ result: "skipped_disabled" });
      await job.moveToCompleted({ skipped: true }, token, false);
      return;
    }

    await deps.deliver(currentConfig.destination, [job.data.event]);
    siemLoggingEventsTotal.inc({ result: "delivered" });
    await job.moveToCompleted({ delivered: true }, token, false);
  } catch (error) {
    const reason =
      error instanceof SiemDeliveryError ? error.kind : "delivery_error";
    siemLoggingEventsTotal.inc({ result: "delivery_failed" });
    siemLoggingDeliveryFailuresTotal.inc({ reason });
    logger.error("SIEM logging event delivery failed", {
      error,
      reason,
      scrapeId: job.data.event.scrape_id,
    });
    if (
      error instanceof SiemDeliveryError &&
      permanentFailureKinds.has(error.kind)
    ) {
      job.discard();
    }
    if (error instanceof SiemDeliveryError) {
      applyRetryAfter(job, error);
    }
    await job.moveToFailed(asError(error), token, false);
  } finally {
    clearInterval(extendLockInterval);
  }
}
