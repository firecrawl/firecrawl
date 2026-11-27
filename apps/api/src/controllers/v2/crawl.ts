import type { Response } from "express";
import { v7 as uuidv7 } from "uuid";
import type {
  CrawlRequest,
  CrawlResponse,
  DefaultRequestParams,
  ErrorResponse,
  RequestWithAuth,
} from "./types";
import { getV2RequestSchemas, toV0CrawlerOptions } from "./types";
import type { StoredCrawl } from "../../lib/crawl-redis";
import { crawlToCrawler, saveCrawl } from "../../lib/crawl-redis";
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
import { finalizeResponse, service } from "../../service";
import type { RequestContext, ResponsePayload } from "../../service";
import type { BillingMetadata } from "../../lib/billing-types";
import { withZeroDataRetention } from "../../lib/otel-tracer";
import { getErrorHttpResponse } from "../../lib/error";
import { currentLimits } from "../../lib/limits";
import { withWebhookSummaryForLog } from "../../services/webhook/log";
import { jsonRecordSchema } from "../../lib/json-types";
import type { JsonObject } from "../../lib/json-types";
import type { InternalOptions } from "../../scraper/scrapeURL";
import { readBooleanField } from "./agent-interop";
import {
  applyPromptCrawlerOptions,
  shouldApplyPromptOption,
} from "./crawl-prompt-options";

type FinalCrawlerOptions = Omit<
  CrawlRequest,
  "url" | "scrapeOptions" | "prompt"
> & {
  url: undefined;
  scrapeOptions: undefined;
  prompt: undefined;
  maxDepth?: number;
};

function toJsonObject(value: unknown): JsonObject {
  const parsed = jsonRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export async function crawlController(
  req: RequestWithAuth<DefaultRequestParams, CrawlResponse, CrawlRequest>,
  res: Response<CrawlResponse | ResponsePayload>,
) {
  const preNormalizedBody = toJsonObject(req.rawRequestBody ?? req.body);
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

  const crawlerOptions: FinalCrawlerOptions = {
    ...req.body,
    url: undefined,
    scrapeOptions: undefined,
    prompt: undefined,
  };
  const scrapeOptions = req.body.scrapeOptions;

  let promptGeneratedOptions: JsonObject = {};
  if (req.body.prompt) {
    const basePrompt = req.body.prompt;
    try {
      // The prompt and the discovered URLs end up in LLM telemetry, so keep
      // this whole step out of traces for zero data retention crawls.
      const extracted = await withZeroDataRetention(
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
          const generated = await generateCrawlerOptionsFromPrompt(
            enhancedPrompt,
            logger,
            new CostTracking(),
            { teamId: req.auth.team_id, crawlId: id },
            zeroDataRetention,
            req.acuc?.flags,
          );
          const rawExtract: unknown = generated.extract;
          return rawExtract;
        },
      );
      promptGeneratedOptions = toJsonObject(extracted);
      logger.debug("Generated crawler options from prompt", {
        prompt: req.body.prompt,
        generatedOptions: promptGeneratedOptions,
      });
      logger.debug(JSON.stringify(promptGeneratedOptions, null, 2));
    } catch (error: unknown) {
      logger.error("Failed to generate crawler options from prompt", {
        error: error instanceof Error ? error.message : String(error),
        prompt: req.body.prompt,
      });
      const httpResponse = getErrorHttpResponse(error);
      if (httpResponse) {
        const errorBody: ErrorResponse = {
          ...httpResponse.extraFields,
          success: false,
          error: httpResponse.message,
          jobId: id,
        };
        if (httpResponse.code) {
          errorBody.code = httpResponse.code;
        }
        return res.status(httpResponse.status).json(errorBody);
      }
      return res.status(400).json({
        success: false,
        error:
          "Failed to process natural language prompt. Please try rephrasing or use explicit crawler options.",
        jobId: id,
      });
    }
  }

  // The request schema already validated user-supplied includePaths /
  // excludePaths. Options generated from a prompt bypass the schema, so hold
  // the merged result to the same caps, budget, and engine syntax.
  if (req.body.prompt) {
    const pathPatternIssues = collectPathPatternIssues({
      includePaths: shouldApplyPromptOption(
        promptGeneratedOptions,
        preNormalizedBody,
        "includePaths",
      )
        ? promptGeneratedOptions.includePaths
        : crawlerOptions.includePaths,
      excludePaths: shouldApplyPromptOption(
        promptGeneratedOptions,
        preNormalizedBody,
        "excludePaths",
      )
        ? promptGeneratedOptions.excludePaths
        : crawlerOptions.excludePaths,
    });
    if (pathPatternIssues.length > 0) {
      return res.status(400).json({
        success: false,
        error: pathPatternIssues[0].message,
        jobId: id,
      });
    }
    if (
      shouldApplyPromptOption(
        promptGeneratedOptions,
        preNormalizedBody,
        "delay",
      )
    ) {
      const generatedDelay = promptGeneratedOptions.delay;
      if (typeof generatedDelay === "number" && generatedDelay > 60) {
        return res.status(400).json({
          success: false,
          error:
            "The delay parameter is measured in seconds and cannot exceed 60 seconds.",
          jobId: id,
        });
      }
    }
  }

  // Merge behavior:
  // - Start with parsed crawlerOptions (which contains schema defaults)
  // - Overlay promptGeneratedOptions ONLY for fields the user did not explicitly provide
  //   in the original request (preNormalizedBody) or provided as null/undefined.
  // This prevents empty defaults like [] from overwriting meaningful prompt-generated values.
  const finalCrawlerOptions: FinalCrawlerOptions = { ...crawlerOptions };
  applyPromptCrawlerOptions(
    finalCrawlerOptions,
    promptGeneratedOptions,
    preNormalizedBody,
  );

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
    .catch((error: unknown) => {
      logger.error("Failed to register crawl job", {
        error,
        estimatedJobs: finalCrawlerOptions.limit,
      });
    });

  const effectiveConcurrency = await currentLimits().concurrency(ctx);
  const threatProtection = contextThreatProtection(ctx);
  const v0CrawlerOptions = toV0CrawlerOptions(finalCrawlerOptions);
  const internalOptions: InternalOptions = {
    ctx,
    disableSmartWaitCache: true,
    teamId: req.auth.team_id,
    orgId: req.acuc?.org_id ?? null,
    zeroDataRetention,
    agentIndexOnly: readBooleanField(req, "agentIndexOnly"),
    teamFlags: req.acuc?.flags ?? null,
  };
  if (threatProtection !== undefined) {
    // Rolling-deploy compatibility dual-write alongside the ctx fallback.
    internalOptions.threatProtection = threatProtection;
  }
  const sc: StoredCrawl = {
    ctx,
    originUrl: req.body.url,
    crawlerOptions: v0CrawlerOptions,
    scrapeOptions,
    internalOptions,
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
  } catch (error: unknown) {
    logger.debug("Failed to get robots.txt (this is probably fine!)", {
      error,
    });
  }

  sc.queueBackend = await resolveNewGroupBackend(sc.team_id, ctx);
  await crawlGroup.addGroup(id, sc.team_id, crawlTtlHours * 60 * 60 * 1000, {
    backend: sc.queueBackend,
    maxConcurrency: sc.maxConcurrency,
    delaySeconds: v0CrawlerOptions.delay,
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

  const responsePayload: ResponsePayload = {
    success: true,
    id,
    url: `${protocol}://${req.host}/v2/crawl/${id}`,
  };
  if (req.body.prompt) {
    responsePayload.promptGeneratedOptions = promptGeneratedOptions;
    responsePayload.finalCrawlerOptions = toJsonObject(finalCrawlerOptions);
  }
  const payload = await finalizeResponse(req, "crawl", responsePayload);
  return res.status(200).json(payload);
}
