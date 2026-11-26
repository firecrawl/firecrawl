import { Response } from "express";
import { v7 as uuidv7 } from "uuid";
import {
  CrawlRequest,
  CrawlResponse,
  getV2RequestSchemas,
  RequestWithAuth,
  toV0CrawlerOptions,
} from "./types";
import { crawlToCrawler, saveCrawl, StoredCrawl } from "../../lib/crawl-redis";
import { _addScrapeJobToBullMQ } from "../../services/queue-jobs";
import { logger as _logger } from "../../lib/logger";
import { generateCrawlerOptionsFromPrompt } from "../../scraper/scrapeURL/transformers/llmExtract";
import { CostTracking } from "../../lib/cost-tracking";
import { buildPromptWithWebsiteStructure } from "../../lib/map-utils";
import { collectPathPatternIssues } from "../../lib/crawl-regex";
import {
  crawlGroup,
  resolveNewGroupBackend,
} from "../../services/worker/nuq-router";
import {
  contextThreatProtection,
  requestContext,
} from "../../lib/request-context";
import type {} from "../../lib/billing-state";
import { finalizeResponse, service, type RequestContext } from "../../service";
import type { BillingMetadata } from "../../lib/billing-types";
import { withZeroDataRetention } from "../../lib/otel-tracer";
import { getErrorHttpResponse } from "../../lib/error";
import { currentLimits } from "../../lib/limits";
import { withWebhookSummaryForLog } from "../../services/webhook/log";

export async function crawlController(
  req: RequestWithAuth<{}, CrawlResponse, CrawlRequest>,
  res: Response<CrawlResponse>,
) {
  const preNormalizedBody =
    (req.rawRequestBody as Partial<CrawlRequest> | undefined) ?? req.body;
  if (!req.ctx) {
    req.body = getV2RequestSchemas().crawl.parse(req.body);
  }
  const id = req.requestId ?? uuidv7();
  const zeroDataRetention =
    req.ctx?.zeroDataRetention ?? Boolean(req.body.zeroDataRetention);

  const logger = _logger.child({
    crawlId: id,
    module: "api/v2",
    method: "crawlController",
    teamId: req.auth.team_id,
    zeroDataRetention,
  });

  logger.debug("Crawl " + id + " starting", {
    request: withWebhookSummaryForLog(req.body),
    originalRequest: withWebhookSummaryForLog(preNormalizedBody),
    account: req.account,
  });

  const billing: BillingMetadata = req.ctx?.billing ?? {
    endpoint: "crawl",
    jobId: id,
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

  // checkCreditsMiddleware sets req.account.remainingCredits from billing.authorize.
  // Default to no cap when unset.
  const remainingCredits = req.account?.remainingCredits ?? Infinity;

  const crawlerOptions = {
    ...req.body,
    url: undefined,
    scrapeOptions: undefined,
    prompt: undefined,
  };
  const scrapeOptions = req.body.scrapeOptions;

  let promptGeneratedOptions = {};
  if (req.body.prompt) {
    const basePrompt = req.body.prompt;
    try {
      // The prompt and the discovered URLs end up in LLM telemetry, so keep
      // this whole step out of traces for zero data retention crawls.
      const { extract } = await withZeroDataRetention(
        zeroDataRetention,
        async () => {
          // Enhance prompt with discovered site URLs (up to 120) to improve option generation
          const { prompt: enhancedPrompt } =
            await buildPromptWithWebsiteStructure({
              basePrompt,
              url: req.body.url,
              teamId: req.auth.team_id,
              orgId: req.acuc?.org_id ?? null,
              flags: req.acuc?.flags ?? null,
              logger,
              limit: 50,
              includeSubdomains: false,
              allowExternalLinks: false,
              useIndex: true,
              maxFireEngineResults: 500,
              zeroDataRetention,
              ctx,
            });
          return generateCrawlerOptionsFromPrompt(
            enhancedPrompt,
            logger,
            new CostTracking(),
            { teamId: req.auth.team_id, crawlId: id },
            zeroDataRetention,
            req.acuc?.flags,
          );
        },
      );
      promptGeneratedOptions = extract || {};
      logger.debug("Generated crawler options from prompt", {
        prompt: req.body.prompt,
        generatedOptions: promptGeneratedOptions,
      });
      logger.debug(JSON.stringify(promptGeneratedOptions, null, 2));
    } catch (error) {
      logger.error("Failed to generate crawler options from prompt", {
        error: error.message,
        prompt: req.body.prompt,
      });
      const httpResponse = getErrorHttpResponse(error);
      if (httpResponse) {
        return res.status(httpResponse.status).json({
          ...httpResponse.extraFields,
          success: false,
          ...(httpResponse.code ? { code: httpResponse.code } : {}),
          error: httpResponse.message,
          jobId: id,
        });
      }
      return res.status(400).json({
        success: false,
        error:
          "Failed to process natural language prompt. Please try rephrasing or use explicit crawler options.",
        jobId: id,
      });
    }
  }

  // Merge behavior:
  // - Start with parsed crawlerOptions (which contains schema defaults)
  // - Overlay promptGeneratedOptions ONLY for fields the user did not explicitly provide
  //   in the original request (preNormalizedBody) or provided as null/undefined.
  // This prevents empty defaults like [] from overwriting meaningful prompt-generated values.
  const finalCrawlerOptions: any = { ...crawlerOptions };
  for (const [key, value] of Object.entries(promptGeneratedOptions)) {
    const userProvided = Object.prototype.hasOwnProperty.call(
      preNormalizedBody,
      key,
    );
    if (
      !userProvided ||
      preNormalizedBody[key] === undefined ||
      preNormalizedBody[key] === null
    ) {
      finalCrawlerOptions[key] = value;
    }
  }

  // The request schema already validated user-supplied includePaths /
  // excludePaths. Options generated from a prompt bypass the schema, so hold
  // the merged result to the same caps, budget, and engine syntax.
  if (req.body.prompt) {
    const pathPatternIssues = collectPathPatternIssues(finalCrawlerOptions);
    if (pathPatternIssues.length > 0) {
      return res.status(400).json({
        success: false,
        error: pathPatternIssues[0].message,
        jobId: id,
      });
    }
  }

  const originalLimit = finalCrawlerOptions.limit;
  finalCrawlerOptions.limit = Math.min(
    remainingCredits,
    finalCrawlerOptions.limit,
  );
  logger.debug("Determined limit: " + finalCrawlerOptions.limit, {
    remainingCredits,
    bodyLimit: originalLimit,
    originalBodyLimit: preNormalizedBody.limit,
  });

  const crawlTtlHours = ctx.crawlTtlHours ?? 24;
  await service.modules.jobStore
    .register({
      id,
      kind: "crawl",
      ctx,
      expiresAtMs: Date.now() + crawlTtlHours * 60 * 60 * 1000,
      clientOrigin: req.body.origin ?? "api",
      estimatedJobs: finalCrawlerOptions.limit,
    })
    .catch(error => {
      logger.error("Failed to register crawl job", {
        error,
        estimatedJobs: finalCrawlerOptions.limit,
      });
    });

  const effectiveConcurrency = await currentLimits().concurrency(ctx);
  const threatProtection = contextThreatProtection(ctx);
  const sc: StoredCrawl = {
    ctx,
    originUrl: req.body.url,
    crawlerOptions: toV0CrawlerOptions(finalCrawlerOptions),
    scrapeOptions,
    internalOptions: {
      ctx,
      disableSmartWaitCache: true,
      teamId: req.auth.team_id,
      orgId: req.acuc?.org_id ?? null,
      zeroDataRetention,
      agentIndexOnly: (req as any).agentIndexOnly ?? false,
      teamFlags: req.acuc?.flags ?? null,
      // Rolling-deploy compatibility dual-write alongside the ctx fallback.
      ...(threatProtection !== undefined ? { threatProtection } : {}),
    },
    team_id: req.auth.team_id,
    createdAt: Date.now(),
    maxConcurrency:
      req.body.maxConcurrency !== undefined
        ? effectiveConcurrency !== null
          ? Math.min(req.body.maxConcurrency, effectiveConcurrency)
          : req.body.maxConcurrency
        : undefined,
    zeroDataRetention,
    v1: true,
    webhook: req.body.webhook,
    origin: req.body.origin,
  };

  const crawler = crawlToCrawler(id, sc, req.acuc?.flags ?? null);

  try {
    sc.robots = await crawler.getRobotsTxt(scrapeOptions.skipTlsVerification);
    // const robotsCrawlDelay = crawler.getRobotsCrawlDelay();
    // if (robotsCrawlDelay !== null && !sc.crawlerOptions.delay) {
    //   sc.crawlerOptions.delay = robotsCrawlDelay;
    // }
  } catch (e) {
    logger.debug("Failed to get robots.txt (this is probably fine!)", {
      error: e,
    });
  }

  sc.queueBackend = await resolveNewGroupBackend(sc.team_id, ctx);
  await crawlGroup.addGroup(id, sc.team_id, crawlTtlHours * 60 * 60 * 1000, {
    backend: sc.queueBackend,
    maxConcurrency: sc.maxConcurrency,
    delaySeconds: sc.crawlerOptions?.delay,
  });

  await saveCrawl(id, sc);

  await _addScrapeJobToBullMQ(
    {
      url: req.body.url,
      mode: "kickoff" as const,
      ctx,
      team_id: req.auth.team_id,
      crawlerOptions: finalCrawlerOptions,
      scrapeOptions: sc.scrapeOptions,
      internalOptions: sc.internalOptions,
      origin: req.body.origin,
      integration: req.body.integration,
      billing,
      crawl_id: id,
      webhook: req.body.webhook,
      v1: true,
      zeroDataRetention: zeroDataRetention || false,
      apiKeyId: req.acuc?.api_key_id ?? null,
    },
    uuidv7(),
  );

  const protocol = req.protocol;

  const payload = await finalizeResponse(req, "crawl", {
    success: true,
    id,
    url: `${protocol}://${req.host}/v2/crawl/${id}`,
    ...(req.body.prompt && {
      promptGeneratedOptions: promptGeneratedOptions,
      finalCrawlerOptions: finalCrawlerOptions,
    }),
  });
  return res.status(200).json(payload as CrawlResponse);
}
