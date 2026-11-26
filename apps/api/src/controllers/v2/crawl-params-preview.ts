import type { Response } from "express";
import { z } from "zod";
import type { ErrorResponse, RequestWithAuth } from "./types";
import { logger as _logger } from "../../lib/logger";
import { generateCrawlerOptionsFromPrompt } from "../../scraper/scrapeURL/transformers/llmExtract";
import { CostTracking } from "../../lib/cost-tracking";
import { buildPromptWithWebsiteStructure } from "../../lib/map-utils";
import { requestContext } from "../../lib/request-context";
import { withZeroDataRetention } from "../../lib/otel-tracer";
import { getErrorHttpResponse } from "../../lib/error";
import { isJsonObject } from "../../lib/json-types";

// Define the request schema for params preview
// Only url and prompt are required/relevant for preview
const crawlParamsPreviewRequestSchema = z.object({
  url: z.url(),
  prompt: z.string().max(10_000),
  // Only keeps the preview's site search and LLM call on the zero data
  // retention path and out of traces, so unlike a crawl it needs no ZDR
  // permission check.
  zeroDataRetention: z.boolean().optional(),
});

type CrawlParamsPreviewRequest = z.infer<
  typeof crawlParamsPreviewRequestSchema
>;

type CrawlParamsPreviewData = {
  url: string;
  includePaths?: Array<string>;
  excludePaths?: Array<string>;
  maxDepth?: number;
  maxDiscoveryDepth?: number;
  crawlEntireDomain?: boolean;
  allowExternalLinks?: boolean;
  allowSubdomains?: boolean;
  sitemap?: "skip" | "include" | "only";
  ignoreQueryParameters?: boolean;
  deduplicateSimilarURLs?: boolean;
  delay?: number;
  limit?: number;
};

type CrawlParamsPreviewResponse =
  | {
      success: true;
      data?: CrawlParamsPreviewData;
    }
  | ErrorResponse;

function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function parseGeneratedCrawlerOptions(
  raw: unknown,
): Omit<CrawlParamsPreviewData, "url"> {
  if (!isJsonObject(raw)) {
    return {};
  }
  const result: Omit<CrawlParamsPreviewData, "url"> = {};
  if (isStringArray(raw.includePaths)) {
    result.includePaths = raw.includePaths;
  }
  if (isStringArray(raw.excludePaths)) {
    result.excludePaths = raw.excludePaths;
  }
  if (typeof raw.maxDepth === "number") {
    result.maxDepth = raw.maxDepth;
  }
  if (typeof raw.maxDiscoveryDepth === "number") {
    result.maxDiscoveryDepth = raw.maxDiscoveryDepth;
  }
  if (typeof raw.crawlEntireDomain === "boolean") {
    result.crawlEntireDomain = raw.crawlEntireDomain;
  }
  if (typeof raw.allowExternalLinks === "boolean") {
    result.allowExternalLinks = raw.allowExternalLinks;
  }
  if (typeof raw.allowSubdomains === "boolean") {
    result.allowSubdomains = raw.allowSubdomains;
  }
  if (
    raw.sitemap === "skip" ||
    raw.sitemap === "include" ||
    raw.sitemap === "only"
  ) {
    result.sitemap = raw.sitemap;
  }
  if (typeof raw.ignoreQueryParameters === "boolean") {
    result.ignoreQueryParameters = raw.ignoreQueryParameters;
  }
  if (typeof raw.deduplicateSimilarURLs === "boolean") {
    result.deduplicateSimilarURLs = raw.deduplicateSimilarURLs;
  }
  if (typeof raw.delay === "number") {
    result.delay = raw.delay;
  }
  if (typeof raw.limit === "number") {
    result.limit = raw.limit;
  }
  return result;
}

export async function crawlParamsPreviewController(
  req: RequestWithAuth<
    Record<string, string>,
    CrawlParamsPreviewResponse,
    CrawlParamsPreviewRequest
  >,
  res: Response<CrawlParamsPreviewResponse>,
) {
  const zeroDataRetention =
    req.ctx?.zeroDataRetention === true || req.body?.zeroDataRetention === true;
  const logger = _logger.child({
    module: "api/v2",
    method: "crawlParamsPreviewController",
    teamId: req.auth.team_id,
    zeroDataRetention,
  });

  try {
    // Parse and validate request body
    const parsedBody = crawlParamsPreviewRequestSchema.parse(req.body);

    logger.debug("Crawl params preview request", {
      url: parsedBody.url,
      prompt: parsedBody.prompt,
    });

    const ctx = req.ctx
      ? zeroDataRetention && !req.ctx.zeroDataRetention
        ? { ...req.ctx, zeroDataRetention: true }
        : req.ctx
      : requestContext({
          teamId: req.auth.team_id,
          zeroDataRetention,
          flags: req.acuc?.flags ?? null,
          orgId: req.acuc?.org_id ?? null,
          apiKeyId: req.acuc?.api_key_id ?? null,
        });
    req.ctx = ctx;

    // The prompt and the discovered URLs end up in LLM telemetry, so keep
    // this whole step out of traces for zero data retention teams.
    const { extract, websiteUrls } = await withZeroDataRetention(
      zeroDataRetention,
      async () => {
        // Build enhanced prompt with website structure
        const { prompt: enhancedPrompt, websiteUrls } =
          await buildPromptWithWebsiteStructure({
            basePrompt: parsedBody.prompt,
            url: parsedBody.url,
            teamId: req.auth.team_id,
            orgId: req.acuc?.org_id ?? null,
            flags: req.acuc?.flags ?? null,
            logger,
            limit: 50,
            includeSubdomains: true,
            allowExternalLinks: false,
            useIndex: true,
            maxFireEngineResults: 500,
            zeroDataRetention,
            ctx,
          });

        // Generate crawler options from enhanced prompt
        const generated = await generateCrawlerOptionsFromPrompt(
          enhancedPrompt,
          logger,
          new CostTracking(),
          { teamId: req.auth.team_id },
          zeroDataRetention,
          req.acuc?.flags,
        );
        const rawExtract: unknown = generated.extract;
        return { extract: rawExtract, websiteUrls };
      },
    );

    const generatedOptions = parseGeneratedCrawlerOptions(extract);

    logger.debug("Generated crawler options from enhanced prompt", {
      originalPrompt: parsedBody.prompt,
      websiteUrlCount: websiteUrls.length,
      generatedOptions,
    });

    // Prepare response data
    const responseData: CrawlParamsPreviewData = {
      url: parsedBody.url,
      ...generatedOptions,
    };

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        code: "BAD_REQUEST",
        error:
          "Invalid request parameters: " +
          error.issues.map(e => e.message).join(", "),
      });
    }

    logger.error("Failed to generate crawler params preview", {
      error: error instanceof Error ? error.message : String(error),
      prompt: req.body.prompt,
    });

    const httpResponse = getErrorHttpResponse(error);
    if (httpResponse) {
      const errorBody: ErrorResponse = {
        ...httpResponse.extraFields,
        success: false,
        error: httpResponse.message,
      };
      if (httpResponse.code) {
        errorBody.code = httpResponse.code;
      }
      return res.status(httpResponse.status).json(errorBody);
    }

    return res.status(400).json({
      success: false,
      error:
        "Failed to process natural language prompt. Please try rephrasing.",
    });
  }
}
