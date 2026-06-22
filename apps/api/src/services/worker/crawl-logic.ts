import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import {
  finishCrawl,
  getCrawlJobs,
  getDoneJobsOrderedLength,
} from "../../lib/crawl-redis";
import { getCrawl } from "../../lib/crawl-redis";
import { creditsBilledByCrawlId } from "../../db/rpc";
import { getJobs } from "../../controllers/v1/crawl-status";
import { logCrawl, logBatchScrape } from "../logging/log_job";
import { createWebhookSender, WebhookEvent } from "../webhook/index";
import type { NuQJob } from "./nuq";

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

    if (config.USE_DB_AUTHENTICATION) {
      try {
        const creditsRows = await creditsBilledByCrawlId(crawlId);
        credits_billed = creditsRows?.[0]?.credits_billed ?? null;
      } catch (error) {
        logger.warn("Credits billed is null", { error });
      }

      if (credits_billed === null) {
        logger.warn("Credits billed is null", {});
      }
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
