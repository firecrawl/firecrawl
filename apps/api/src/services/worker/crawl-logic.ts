import { logger as _logger } from "../../lib/logger";
import {
  finishCrawl,
  getCrawlJobs,
  getDoneJobsOrderedLength,
} from "../../lib/crawl-redis";
import { getCrawl } from "../../lib/crawl-redis";
import { getJobs } from "../../controllers/v2/crawl-status";
import { createWebhookSender, WebhookEvent } from "../webhook/index";
import type { NuQJob } from "./nuq";
import { crawlContext, jobContext } from "../../lib/request-context";
import type { RequestContext } from "../../service/request-context";
import { installedService } from "../../service/service";
import { service } from "../../service";

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
  const baseCtx = crawlContext(sc);
  const zeroDataRetention =
    baseCtx.zeroDataRetention ||
    (data ? jobContext(data).zeroDataRetention : false);
  const ctx: RequestContext =
    zeroDataRetention && !baseCtx.zeroDataRetention
      ? { ...baseCtx, zeroDataRetention: true }
      : baseCtx;
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

    const totalCredits = fullDocs.reduce(
      (acc, doc) => acc + (doc?.metadata?.creditsUsed ?? 0),
      0,
    );

    const hooks = installedService()?.hooks;
    if (hooks?.has("crawl.finished")) {
      await hooks.run("crawl.finished", {
        id: crawlId,
        kind: sc.crawlerOptions !== null ? "crawl" : "batchScrape",
        ctx,
        completed: fullDocs.length,
        cancelled: sc.cancelled ?? false,
        requestId,
        origin: sc.origin ?? data?.origin,
        originUrl: sc.originUrl,
        crawlerOptions: sc.crawlerOptions,
        charged: totalCredits,
        isV1: false,
        ...(monitoring ? { metadata: { monitoring } } : {}),
      });
    }

    // v0 web hooks, call when done with all the data
    if (!isV1) {
      const sender = await createWebhookSender({
        teamId,
        jobId: crawlId,
        webhook,
        v0: true,
        zeroDataRetention,
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

    const FINALIZE_USAGE_RETRY_ATTEMPTS = 3;
    const FINALIZE_USAGE_RETRY_MS = 500;
    let credits_billed: number | null = null;
    let lastUsageError: unknown = null;

    for (let attempt = 1; attempt <= FINALIZE_USAGE_RETRY_ATTEMPTS; attempt++) {
      try {
        credits_billed = await service.modules.jobStore.usage(requestId, {
          finalize: true,
        });
        lastUsageError = null;
        break;
      } catch (error) {
        lastUsageError = error;
        logger.warn("Job store usage read failed", {
          error,
          requestId,
          attempt,
        });
        if (attempt < FINALIZE_USAGE_RETRY_ATTEMPTS) {
          await new Promise(resolve =>
            setTimeout(resolve, FINALIZE_USAGE_RETRY_MS),
          );
        }
      }
    }
    if (lastUsageError !== null) {
      logger.error("Failed to read crawl usage after retries", {
        error: lastUsageError,
        requestId,
        attempts: FINALIZE_USAGE_RETRY_ATTEMPTS,
      });
    }

    const hooks = installedService()?.hooks;
    if (hooks?.has("crawl.finished")) {
      await hooks.run("crawl.finished", {
        id: crawlId,
        kind: sc.crawlerOptions !== null ? "crawl" : "batchScrape",
        ctx,
        completed: num_docs,
        cancelled: sc.cancelled ?? false,
        requestId,
        origin: sc.origin ?? data?.origin,
        originUrl: sc.originUrl,
        crawlerOptions: sc.crawlerOptions,
        charged: credits_billed,
        isV1: true,
        ...(monitoring ? { metadata: { monitoring } } : {}),
      });
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
