import type { Response } from "express";
import { v7 as uuidv7 } from "uuid";
import type {
  BatchScrapeRequest,
  RequestWithAuth,
  ScrapeOptions,
  BatchScrapeResponse,
} from "./types";
import { parseBatchScrapeRequest, URL as urlSchema } from "./types";
import type { StoredCrawl } from "../../lib/crawl-redis";
import {
  addCrawlJobs,
  finishCrawlKickoff,
  getCrawl,
  lockURLs,
  saveCrawl,
} from "../../lib/crawl-redis";
import { resolveJobPriority } from "../../lib/limits";
import { addScrapeJobs } from "../../services/queue-jobs";
import { createWebhookSender, WebhookEvent } from "../../services/webhook";
import { logger as _logger } from "../../lib/logger";
import { UNSUPPORTED_SITE_MESSAGE } from "../../lib/strings";
import { finalizeResponse, service } from "../../service";
import type { RequestContext, ResponsePayload } from "../../service";
import {
  crawlGroup,
  resolveNewGroupBackend,
} from "../../services/worker/nuq-router";
import {
  contextThreatProtection,
  requestContext,
} from "../../lib/request-context";
import type {} from "../../lib/billing-state";
import type { BillingMetadata } from "../../lib/billing-types";
import { summarizeWebhookForLog } from "../../services/webhook/log";
import { readAgentInterop, readBooleanField } from "./agent-interop";
import type { InternalOptions } from "../../scraper/scrapeURL";

export async function batchScrapeController(
  req: RequestWithAuth<
    Record<string, string>,
    BatchScrapeResponse,
    BatchScrapeRequest
  >,
  res: Response<BatchScrapeResponse | ResponsePayload>,
) {
  if (!req.ctx) {
    req.body = parseBatchScrapeRequest(req.body);
  }
  const agentInterop = readAgentInterop(req.body);
  const shouldBill = agentInterop?.shouldBill ?? true;
  const agentRequestId = agentInterop?.requestId;

  const zeroDataRetention =
    req.ctx?.zeroDataRetention ??
    ((req.body.zeroDataRetention ?? false) ||
      readBooleanField(req.body, "lockdown"));

  // Only batch scrapes can be appended to: crawls (including monitor crawls)
  // carry their own billing and scope.
  const appendTarget = req.body.appendToId
    ? await getCrawl(req.body.appendToId)
    : null;
  if (
    req.body.appendToId &&
    (!appendTarget ||
      appendTarget.team_id !== req.auth.team_id ||
      (appendTarget.crawlerOptions !== null &&
        appendTarget.crawlerOptions !== undefined))
  ) {
    return res.status(404).json({
      success: false,
      error: "Job not found",
    });
  }

  const id = req.body.appendToId ?? req.requestId ?? uuidv7();
  const billing: BillingMetadata = req.ctx?.billing ?? {
    ...(agentInterop
      ? { endpoint: "agent" as const, jobId: id }
      : { endpoint: "batch_scrape" as const, jobId: id }),
    hostedMcp: req.auth.hostedMcp,
  };
  const ctx: RequestContext = req.ctx
    ? req.ctx.billing
      ? req.ctx
      : { ...req.ctx, billing }
    : requestContext({
        teamId: req.auth.team_id,
        zeroDataRetention,
        flags: req.acuc?.flags ?? null,
        orgId: req.acuc?.org_id ?? null,
        apiKeyId: req.acuc?.api_key_id ?? null,
        billing,
        concurrencyLimit: req.acuc?.concurrency_limit,
        rateLimitMultiplier: req.acuc?.rate_limit_multiplier,
      });
  req.ctx = ctx;

  const logger = _logger.child({
    crawlId: id,
    batchScrapeId: id,
    module: "api/v2",
    method: "batchScrapeController",
    teamId: req.auth.team_id,
    zeroDataRetention,
  });

  const blockCtx: RequestContext =
    appendTarget?.zeroDataRetention === true && !ctx.zeroDataRetention
      ? { ...ctx, zeroDataRetention: true }
      : ctx;
  const shouldCheckBlocklist = !req.requestBlocklistChecked;
  const isBlockedUrl = (url: string): boolean =>
    shouldCheckBlocklist &&
    service.modules.blocklist.isBlocked(url, blockCtx, {
      origin: req.body.origin ?? null,
    });

  let urls: Array<string> = req.body.urls;
  let invalidURLs: Array<string> | undefined =
    req.requestDroppedUrls && req.requestDroppedUrls.length > 0
      ? [...req.requestDroppedUrls]
      : undefined;
  let blockedFound = false;

  if (req.body.ignoreInvalidURLs) {
    invalidURLs = invalidURLs ?? [];

    const pendingURLs = urls;
    urls = [];
    for (const u of pendingURLs) {
      try {
        const nu = urlSchema.parse(u);
        if (!isBlockedUrl(nu)) {
          urls.push(nu);
        } else {
          invalidURLs.push(u);
          blockedFound = true;
        }
      } catch {
        invalidURLs.push(u);
      }
    }
  } else if (shouldCheckBlocklist) {
    for (const url of urls) {
      if (isBlockedUrl(url)) {
        blockedFound = true;
        break;
      }
    }
  }

  if (!req.body.ignoreInvalidURLs && blockedFound) {
    return res.status(403).json({
      success: false,
      error: UNSUPPORTED_SITE_MESSAGE,
    });
  }

  if (urls.length === 0) {
    return res.status(400).json({
      success: false,
      error: "No valid URLs provided",
    });
  }

  logger.debug("Batch scrape " + id + " starting", {
    urlsLength: urls.length,
    appendToId: req.body.appendToId,
    account: req.account,
  });

  const workContactOnly =
    req.headers["x-firecrawl-work-contact-only"] === "true";
  const threatProtection = contextThreatProtection(ctx);
  let sc: StoredCrawl;
  if (appendTarget) {
    sc = appendTarget;
  } else {
    // Smart wait is disabled for batch scrapes to ensure contentful scrapes.
    const internalOptions: InternalOptions = {
      ctx,
      disableSmartWaitCache: true,
      teamId: req.auth.team_id,
      orgId: req.acuc?.org_id ?? null,
      zeroDataRetention,
      bypassBilling: !shouldBill,
      agentIndexOnly: readBooleanField(req, "agentIndexOnly"),
      teamFlags: req.acuc?.flags ?? null,
    };
    if (workContactOnly) {
      internalOptions.workContactOnly = true;
    }
    if (threatProtection !== undefined) {
      // Rolling-deploy compatibility dual-write alongside the ctx fallback.
      internalOptions.threatProtection = threatProtection;
    }
    sc = {
      ctx,
      crawlerOptions: null,
      scrapeOptions: req.body,
      internalOptions,
      team_id: req.auth.team_id,
      createdAt: Date.now(),
      maxConcurrency: req.body.maxConcurrency,
      zeroDataRetention,
      v1: true,
      webhook: req.body.webhook,
      requestId: agentRequestId,
      origin: req.body.origin,
    };
  }

  if (req.body.appendToId) {
    sc.ctx = blockCtx;
    sc.internalOptions.ctx = blockCtx;
    // Rolling-deploy compatibility dual-write alongside the ctx fallback.
    sc.internalOptions.threatProtection = contextThreatProtection(blockCtx);
    sc.internalOptions.bypassBilling = !shouldBill;
    sc.internalOptions.teamFlags = req.acuc?.flags ?? undefined;
    if (workContactOnly) {
      sc.internalOptions.workContactOnly = true;
    }
  }

  const crawlTtlHours = ctx.crawlTtlHours ?? 24;

  if (!req.body.appendToId && !agentInterop) {
    await service.modules.jobStore
      .register({
        id,
        kind: "batchScrape",
        ctx,
        expiresAtMs: Date.now() + crawlTtlHours * 60 * 60 * 1000,
        clientOrigin: req.body.origin ?? "api",
        estimatedJobs: urls.length,
      })
      .catch((error: unknown) => {
        logger.error("Failed to register batch scrape job", {
          error,
          estimatedJobs: urls.length,
        });
      });
  } else if (!req.body.appendToId) {
    // An agent-started batch is recorded under the parent request rather than
    // as a request of its own, so initialize usage tracking for both ids
    // without creating fetchable job-access rows.
    if (agentRequestId) {
      await service.modules.jobStore
        .register({
          id: agentRequestId,
          kind: "batchScrape",
          ctx,
          jobAccess: false,
          estimatedJobs: 0,
        })
        .catch((error: unknown) => {
          logger.error("Failed to initialize request usage tracking", {
            error,
            requestId: agentRequestId,
          });
        });
    }
    await service.modules.jobStore
      .register({
        id,
        kind: "batchScrape",
        ctx,
        jobAccess: false,
        estimatedJobs: urls.length,
      })
      .catch((error: unknown) => {
        logger.error("Failed to initialize request usage tracking", {
          error,
          estimatedJobs: urls.length,
        });
      });
  }

  if (!req.body.appendToId) {
    sc.ctx = ctx;
    sc.queueBackend = await resolveNewGroupBackend(sc.team_id, ctx);
    await crawlGroup.addGroup(id, sc.team_id, crawlTtlHours * 60 * 60 * 1000, {
      backend: sc.queueBackend,
      maxConcurrency: sc.maxConcurrency,
      delaySeconds: undefined,
    });
    await saveCrawl(id, sc);
  }

  let jobPriority = 20;

  // If it is over 1000, we need to get the job priority,
  // otherwise we can use the default priority of 20
  if (urls.length > 1000) {
    // set base to 21
    jobPriority = await resolveJobPriority(ctx, 21, error => {
      logger.error("Failed to determine job priority", { error });
    });
  }
  logger.debug("Using job priority " + jobPriority, { jobPriority });

  const {
    urls: _urls,
    appendToId: _appendToId,
    ...restScrapeOptions
  } = req.body;
  const scrapeOptions: ScrapeOptions = restScrapeOptions;

  const jobs = urls.map(x => ({
    jobId: uuidv7(),
    data: {
      url: x,
      mode: "single_urls" as const,
      ctx,
      team_id: req.auth.team_id,
      crawlerOptions: null,
      scrapeOptions,
      origin: sc.origin ?? req.body.origin ?? "api",
      integration: req.body.integration,
      billing,
      crawl_id: id,
      requestId: agentRequestId,
      bypassBilling: !shouldBill,
      sitemapped: true,
      v1: true,
      webhook: req.body.webhook,
      internalOptions: sc.internalOptions,
      zeroDataRetention,
      apiKeyId: req.acuc?.api_key_id ?? null,
    },
    priority: jobPriority,
  }));

  await finishCrawlKickoff(id);

  logger.debug("Locking URLs...");
  await lockURLs(
    id,
    sc,
    jobs.map(x => x.data.url),
    logger,
  );
  logger.debug("Adding scrape jobs to Redis...");
  await addCrawlJobs(
    id,
    jobs.map(x => x.jobId),
    logger,
  );
  logger.debug("Adding scrape jobs to BullMQ...");
  await addScrapeJobs(jobs);

  if (req.body.webhook) {
    logger.debug("Calling webhook with batch_scrape.started...", {
      webhook: summarizeWebhookForLog(req.body.webhook),
    });
    const sender = await createWebhookSender({
      teamId: req.auth.team_id,
      jobId: id,
      webhook: req.body.webhook,
      v0: false,
    });
    await sender?.send(WebhookEvent.BATCH_SCRAPE_STARTED, { success: true });
  }

  const protocol = req.protocol;

  const payload = await finalizeResponse(req, "batchScrape", {
    success: true,
    id,
    url: `${protocol}://${req.host}/v2/batch/scrape/${id}`,
    invalidURLs,
  });
  return res.status(200).json(payload);
}
