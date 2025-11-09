import type { Logger } from "winston";
import {
  getScrapeJobCancellationReason,
  isScrapeJobCancelled,
} from "../job-cancellation";
import { ScrapeJobCancelledError } from "../../scraper/scrapeURL/error";
import type { AbortInstance } from "../../scraper/scrapeURL/lib/abortManager";

const DEFAULT_POLL_INTERVAL_MS =
  Number(process.env.SCRAPE_CANCELLATION_POLL_INTERVAL_MS) || 1000;

export type JobCancellationWatcher = {
  abortInstance: AbortInstance;
  stop: () => void;
  throwIfCancelled: () => Promise<void>;
};

export function createJobCancellationWatcher(
  jobId: string,
  logger: Logger,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): JobCancellationWatcher {
  const controller = new AbortController();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const abortWithReason = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  const poll = async () => {
    if (stopped) {
      return;
    }

    try {
      if (await isScrapeJobCancelled(jobId)) {
        const reason = await getScrapeJobCancellationReason(jobId);
        logger.info("Scrape job cancellation detected", {
          module: "scrape/cancellation",
          source: "worker",
          jobId,
          reason,
        });
        abortWithReason();
        stopped = true;
        return;
      }
    } catch (error) {
      logger.debug("Failed to poll job cancellation state", {
        module: "scrape/cancellation",
        source: "worker",
        jobId,
        error,
      });
    }

    timer = setTimeout(poll, pollIntervalMs);
  };

  poll();

  return {
    abortInstance: {
      signal: controller.signal,
      tier: "external",
      throwable: () => new ScrapeJobCancelledError(),
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
    async throwIfCancelled() {
      if (controller.signal.aborted) {
        throw new ScrapeJobCancelledError();
      }

      if (await isScrapeJobCancelled(jobId)) {
        abortWithReason();
        throw new ScrapeJobCancelledError();
      }
    },
  };
}
