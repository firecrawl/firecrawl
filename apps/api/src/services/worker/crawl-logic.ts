import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import {
  finishCrawl,
  getCrawl,
  getCrawlJobs,
  getDoneJobsOrderedLength,
  isCrawlFinishMarked,
} from "../../lib/crawl-redis";
import type { StoredCrawl } from "../../lib/crawl-redis";
import { recordCrawlStateMissing } from "../../lib/crawl-state-metrics";
import { getJobs } from "../../controllers/v2/crawl-status";
import type {
  DocumentMetadata,
  ScrapeOptions,
} from "../../controllers/v2/types";
import { createWebhookSender, WebhookEvent } from "../webhook/index";
import type { NuQJob } from "./nuq";
import { crawlContext, jobContext } from "../../lib/request-context";
import { safeParseLogged, zCatchLogged } from "../../lib/zod-log";
import type { RequestContext } from "../../service/request-context";
import type { CrawlFinished } from "../../service/hooks";
import { installedService } from "../../service/service";
import { service } from "../../service";
import type { JobCrawlerOptions, ScrapeJobData } from "../../types";

type FinishCrawlJob = Pick<
  NuQJob<ScrapeJobData | null>,
  "id" | "groupId" | "data"
>;

type V0CrawlDoc = {
  content: string;
  markdown?: string;
  metadata: Partial<DocumentMetadata>;
  source: string;
  creditsUsed: number;
};

const defaultStoredScrapeOptions: Omit<ScrapeOptions, "timeout"> = {
  formats: [{ type: "markdown" }],
  onlyMainContent: true,
  onlyCleanContent: false,
  waitFor: 0,
  mobile: false,
  removeBase64Images: true,
  fastMode: false,
  blockAds: true,
  proxy: "auto",
  checkPromptInjection: false,
};

const jobCrawlerOptionsShapeSchema = z.looseObject({
  limit: z.number().nullish(),
  maxDiscoveryDepth: z.number().nullish(),
  currentDiscoveryDepth: z.number().nullish(),
});

const jobCrawlerOptionsSchema = z.custom<JobCrawlerOptions>(
  value =>
    safeParseLogged(
      jobCrawlerOptionsShapeSchema,
      value,
      "crawl-logic.crawlerOptions",
    ).success,
);

const v0DocumentMetadataShapeSchema = z.looseObject({});

const v0DocumentMetadataSchema = z.custom<Partial<DocumentMetadata>>(
  value =>
    safeParseLogged(
      v0DocumentMetadataShapeSchema,
      value,
      "crawl-logic.v0DocumentMetadata",
    ).success,
);

const stringSchema = z.string();
const numberSchema = z.number();

function softV0String(field: string) {
  return zCatchLogged(
    z
      .string()
      .nullable()
      .transform(value => value ?? undefined)
      .optional(),
    undefined,
    `crawl-logic.v0CrawlDoc.${field}`,
  );
}

const v0CrawlDocRawSchema = z.object({
  content: softV0String("content"),
  rawHtml: softV0String("rawHtml"),
  markdown: softV0String("markdown"),
  url: softV0String("url"),
  metadata: z.unknown().optional(),
});

function extractV0CrawlDoc(returnvalue: unknown): V0CrawlDoc | null {
  const raw: unknown = Array.isArray(returnvalue)
    ? returnvalue[0]
    : returnvalue;
  if (raw === null || raw === undefined) {
    return null;
  }
  const parsed = safeParseLogged(
    v0CrawlDocRawSchema,
    raw,
    "crawl-logic.v0CrawlDoc",
  );
  if (!parsed.success) {
    return null;
  }
  const rawMetadata = parsed.data.metadata;
  const metadataParsed =
    rawMetadata !== null && rawMetadata !== undefined
      ? v0DocumentMetadataSchema.safeParse(rawMetadata)
      : undefined;
  const metadata: Partial<DocumentMetadata> = metadataParsed?.success
    ? metadataParsed.data
    : {};
  const sourceURLParsed =
    metadata.sourceURL !== null && metadata.sourceURL !== undefined
      ? safeParseLogged(
          stringSchema,
          metadata.sourceURL,
          "crawl-logic.v0DocumentMetadata.sourceURL",
        )
      : undefined;
  const creditsUsedParsed =
    metadata.creditsUsed !== null && metadata.creditsUsed !== undefined
      ? safeParseLogged(
          numberSchema,
          metadata.creditsUsed,
          "crawl-logic.v0DocumentMetadata.creditsUsed",
        )
      : undefined;
  const markdown = parsed.data.markdown;
  const content = parsed.data.content ?? parsed.data.rawHtml ?? markdown ?? "";
  const source = sourceURLParsed?.success
    ? sourceURLParsed.data
    : (parsed.data.url ?? "");
  const creditsUsed = creditsUsedParsed?.success ? creditsUsedParsed.data : 0;
  return { content, markdown, metadata, source, creditsUsed };
}

export async function finishCrawlSuper(job: FinishCrawlJob) {
  const crawlId = job.groupId;

  if (!crawlId) {
    return;
  }

  let sc = await getCrawl(crawlId);
  if (!sc) {
    if (await isCrawlFinishMarked(crawlId)) {
      _logger.info("Crawl already finished, skipping duplicate finish", {
        crawlId,
        jobId: job.id,
      });
      return;
    }
    sc = storedCrawlFromJob(crawlId, job);
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
  const parsedCrawlerOptions =
    sc.crawlerOptions !== null && sc.crawlerOptions !== undefined
      ? jobCrawlerOptionsSchema.safeParse(sc.crawlerOptions)
      : undefined;
  const crawlerOptions = parsedCrawlerOptions?.success
    ? parsedCrawlerOptions.data
    : null;

  logger.info("Finishing crawl");
  await finishCrawl(crawlId, logger);

  if (!isV1) {
    const jobIDs = await getCrawlJobs(crawlId);

    const jobs = (await getJobs(jobIDs)).sort(
      (a, b) => a.timestamp - b.timestamp,
    );

    const fullDocs = jobs
      .map(x => extractV0CrawlDoc(x.returnvalue))
      .filter((x): x is V0CrawlDoc => x !== null);

    const totalCredits = fullDocs.reduce(
      (acc, doc) => acc + doc.creditsUsed,
      0,
    );

    const hooks = installedService()?.hooks;
    if (hooks?.has("crawl.finished")) {
      const event: CrawlFinished = {
        id: crawlId,
        kind: sc.crawlerOptions !== null ? "crawl" : "batchScrape",
        ctx,
        completed: fullDocs.length,
        cancelled: sc.cancelled ?? false,
        requestId,
        origin: sc.origin ?? data?.origin,
        originUrl: sc.originUrl,
        crawlerOptions,
        charged: totalCredits,
        isV1: false,
      };
      if (monitoring) {
        event.metadata = { monitoring };
      }
      await hooks.run("crawl.finished", event);
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
        const documents = fullDocs.map(doc => ({
          content: {
            content: doc.content,
            markdown: doc.markdown,
            metadata: doc.metadata,
          },
          source: doc.source,
        }));
        if (sc.crawlerOptions !== null) {
          void sender.send(WebhookEvent.CRAWL_COMPLETED, {
            success: true,
            data: documents,
          });
        } else {
          void sender.send(WebhookEvent.BATCH_SCRAPE_COMPLETED, {
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

    for (let attempt = 1; attempt <= FINALIZE_USAGE_RETRY_ATTEMPTS; attempt++) {
      try {
        credits_billed = await service.modules.jobStore.usage(requestId, {
          finalize: true,
        });
        break;
      } catch (error: unknown) {
        logger.warn("Job store usage read failed", {
          error,
          requestId,
          attempt,
        });
        if (attempt < FINALIZE_USAGE_RETRY_ATTEMPTS) {
          await new Promise<void>(resolve => {
            setTimeout(resolve, FINALIZE_USAGE_RETRY_MS);
          });
        } else {
          logger.error("Failed to read crawl usage after retries", {
            error,
            requestId,
            attempts: FINALIZE_USAGE_RETRY_ATTEMPTS,
          });
        }
      }
    }

    const hooks = installedService()?.hooks;
    if (hooks?.has("crawl.finished")) {
      const event: CrawlFinished = {
        id: crawlId,
        kind: sc.crawlerOptions !== null ? "crawl" : "batchScrape",
        ctx,
        completed: num_docs,
        cancelled: sc.cancelled ?? false,
        requestId,
        origin: sc.origin ?? data?.origin,
        originUrl: sc.originUrl,
        crawlerOptions,
        charged: credits_billed,
        isV1: true,
      };
      if (monitoring) {
        event.metadata = { monitoring };
      }
      await hooks.run("crawl.finished", event);
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
          void sender.send(WebhookEvent.CRAWL_COMPLETED, {
            success: true,
            data: [],
          });
        } else {
          void sender.send(WebhookEvent.BATCH_SCRAPE_COMPLETED, {
            success: true,
            data: [],
          });
        }
      }
    }
  }
}

/**
 * Rebuilds what the finish path needs from a member job when the stored crawl
 * is gone, so the crawl still finishes and sends its webhook. Lossy: member
 * data has no cancel flag or origin URL. Throws when the member job's data was
 * shed too, which fails the finish job visibly.
 */
function storedCrawlFromJob(crawlId: string, job: FinishCrawlJob): StoredCrawl {
  const data = job.data;
  recordCrawlStateMissing("finalizer", crawlId, _logger, {
    module: "queue-worker",
    method: "finishCrawl",
    jobId: job.id,
    recoverable: !!data,
  });
  if (!data) {
    throw new Error(
      "Stored crawl missing and member job data unavailable, cannot finish crawl",
    );
  }
  const isSitemap = data.mode === "kickoff_sitemap";
  const ctx = jobContext(data);
  const fallbackInternalOptions = {
    teamId: data.team_id,
    orgId: ctx.orgId ?? null,
    zeroDataRetention: ctx.zeroDataRetention,
  };
  return {
    ctx,
    crawlerOptions: isSitemap ? null : (data.crawlerOptions ?? null),
    scrapeOptions: isSitemap ? defaultStoredScrapeOptions : data.scrapeOptions,
    internalOptions: isSitemap
      ? fallbackInternalOptions
      : (data.internalOptions ?? fallbackInternalOptions),
    team_id: data.team_id,
    createdAt: Date.now(),
    zeroDataRetention: data.zeroDataRetention,
    v1: data.v1,
    webhook: data.webhook,
    requestId: data.requestId,
    origin: data.origin,
  };
}
