import { logger as _logger } from "../../lib/logger";
import {
  finishCrawl,
  getCrawlJobs,
  getDoneJobsOrderedLength,
} from "../../lib/crawl-redis";
import { getCrawl } from "../../lib/crawl-redis";
import { readRequestCredits } from "../../lib/request-credits-store";
import { getJobs } from "../../controllers/v1/crawl-status";
import { logCrawl, logBatchScrape } from "../logging/log_job";
import { createWebhookSender, WebhookEvent } from "../webhook/index";
import type { NuQJob } from "./nuq";
import { readRequestCreditsFromAnalytics } from "../../lib/request-credits-analytics";

/**
 * How often, and how long apart, finalization re-reads the ClickHouse credits
 * sum before believing an empty result. ClickPipes lands a child's row one to
 * two seconds after the worker logs it; five reads two seconds apart outwait
 * that with room to spare without holding the finalizer for long.
 */
const FINALIZE_CREDITS_ATTEMPTS = 5;
const FINALIZE_CREDITS_RETRY_MS = 2_000;

export async function finishCrawlSuper(job: NuQJob<any>) {
  const crawlId = job.groupId;

  if (!crawlId) {
    return;
  }

  const sc = await getCrawl(crawlId);

  if (!sc) {
    return;
  }

  const logger = _logger.child({
    module: "queue-worker",
    method: "finishCrawl",
    jobId: job.id,
    scrapeId: job.id,
    crawlId,
    zeroDataRetention: sc.internalOptions.zeroDataRetention,
  });

  // On the FDB backend a completed member's input data is shed for ZDR crawls,
  // so `job.data` can be null here. Prefer the member's job data when present,
  // otherwise recover the crawl-scoped context persisted on the stored crawl.
  const data = job.data;
  const isV1 = data ? !!data.v1 : (sc.v1 ?? true);
  const teamId = data?.team_id ?? sc.team_id;
  const requestId = data?.requestId ?? sc.requestId ?? crawlId;
  const zeroDataRetention = sc.zeroDataRetention || data?.zeroDataRetention;
  const webhook = data?.webhook ?? sc.webhook;
  const monitoring = data?.monitoring;

  logger.info("Finishing crawl");
  await finishCrawl(crawlId, logger);

  if (!isV1) {
    const jobIDs = await getCrawlJobs(crawlId);

    const jobs = (await getJobs(jobIDs)).sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    // const jobStatuses = await Promise.all(jobs.map((x) => x.getState()));
    const jobStatus = sc.cancelled // || jobStatuses.some((x) => x === "failed")
      ? "failed"
      : "completed";

    const fullDocs = jobs
      .map(x =>
        x.returnvalue
          ? Array.isArray(x.returnvalue)
            ? x.returnvalue[0]
            : x.returnvalue
          : null,
      )
      .filter(x => x !== null);

    if (sc.crawlerOptions !== null) {
      await logCrawl(
        {
          id: crawlId,
          request_id: requestId,
          url: sc.originUrl!,
          team_id: teamId,
          options: sc.crawlerOptions,
          num_docs: fullDocs.length,
          credits_cost: fullDocs.reduce(
            (acc, doc) => acc + (doc?.metadata?.creditsUsed ?? 0),
            0,
          ),
          zeroDataRetention,
          cancelled: sc.cancelled ?? false,
          monitor_id: monitoring?.monitorId,
          monitor_check_id: monitoring?.checkId,
        },
        false,
      );
    } else {
      await logBatchScrape(
        {
          id: crawlId,
          request_id: requestId,
          team_id: teamId,
          num_docs: fullDocs.length,
          credits_cost: fullDocs.reduce(
            (acc, doc) => acc + (doc?.metadata?.creditsUsed ?? 0),
            0,
          ),
          zeroDataRetention,
          cancelled: sc.cancelled ?? false,
        },
        false,
      );
    }

    // v0 web hooks, call when done with all the data
    if (!isV1) {
      const sender = await createWebhookSender({
        teamId,
        jobId: crawlId,
        webhook,
        v0: true,
      });
      if (sender) {
        const documents = fullDocs.map((doc: any) => ({
          content: {
            content: doc?.content ?? doc?.rawHtml ?? doc?.markdown ?? "",
            markdown: doc?.markdown,
            metadata: doc?.metadata ?? {},
          },
          source: doc?.metadata?.sourceURL ?? doc?.url ?? "",
        }));
        if (sc.crawlerOptions !== null) {
          sender.send(WebhookEvent.CRAWL_COMPLETED, {
            success: true,
            data: documents,
          });
        } else {
          sender.send(WebhookEvent.BATCH_SCRAPE_COMPLETED, {
            success: true,
            data: documents,
          });
        }
      }
    }
  } else {
    const num_docs = await getDoneJobsOrderedLength(crawlId);

    let credits_billed: number | null = null;

    try {
      credits_billed = await readRequestCredits(requestId);
    } catch (error) {
      logger.warn("Bigtable request credits read failed", { error });
    }

    if (credits_billed === null) {
      // Requests from before the Bigtable credit rows existed: sum the scrape
      // job log. Finalization records credits_cost for good, and ClickPipes
      // lands the last children a second or two after they are logged, so an
      // empty sum is retried before it is believed.
      for (let attempt = 1; attempt <= FINALIZE_CREDITS_ATTEMPTS; attempt++) {
        try {
          credits_billed = await readRequestCreditsFromAnalytics(requestId, {
            emptyAsZero: false,
          });
        } catch (error) {
          logger.warn("Analytics request credits read failed", {
            error,
            attempt,
          });
        }
        if (credits_billed !== null) break;
        if (attempt < FINALIZE_CREDITS_ATTEMPTS) {
          await new Promise(resolve =>
            setTimeout(resolve, FINALIZE_CREDITS_RETRY_MS),
          );
        }
      }
    }

    if (credits_billed === null) {
      // The row's credits_cost is NOT NULL, so the record has to carry a
      // number; 0 is written and the gap is loud rather than silent.
      logger.error(
        "Credits billed unknown at crawl finalization; recording 0",
        { requestId, attempts: FINALIZE_CREDITS_ATTEMPTS },
      );
    }

    if (sc.crawlerOptions !== null) {
      await logCrawl(
        {
          id: crawlId,
          request_id: requestId,
          url: sc.originUrl!,
          team_id: teamId,
          options: sc.crawlerOptions,
          num_docs: num_docs,
          credits_cost: credits_billed ?? 0,
          zeroDataRetention,
          cancelled: sc.cancelled ?? false,
          monitor_id: monitoring?.monitorId,
          monitor_check_id: monitoring?.checkId,
        },
        false,
      );
    } else {
      await logBatchScrape(
        {
          id: crawlId,
          request_id: requestId,
          team_id: teamId,
          num_docs: num_docs,
          credits_cost: credits_billed ?? 0,
          zeroDataRetention,
          cancelled: sc.cancelled ?? false,
        },
        false,
      );
    }

    // v1 web hooks, call when done with no data, but with event completed
    if (isV1 && webhook) {
      const sender = await createWebhookSender({
        teamId,
        jobId: crawlId,
        webhook,
        v0: false,
      });
      if (sender) {
        if (sc.crawlerOptions !== null) {
          sender.send(WebhookEvent.CRAWL_COMPLETED, {
            success: true,
            data: [],
          });
        } else {
          sender.send(WebhookEvent.BATCH_SCRAPE_COMPLETED, {
            success: true,
            data: [],
          });
        }
      }
    }
  }
}
