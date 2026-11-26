import type { Response } from "express";
import type { OngoingCrawlsResponse, RequestWithAuth } from "./types";
import { toV2CrawlerOptions } from "./types";
import { getCrawl } from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
import { crawlGroup } from "../../services/worker/nuq-router";
import { requestContext } from "../../lib/request-context";
import { isJsonObject } from "../../lib/json-types";
configDotenv();

type StoredCrawlerOptionsInput = Parameters<typeof toV2CrawlerOptions>[0];

function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function toStoredCrawlerOptionsInput(
  value: unknown,
): StoredCrawlerOptionsInput | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const input: StoredCrawlerOptionsInput = {};
  if (isStringArray(value.includes)) {
    input.includes = value.includes;
  }
  if (isStringArray(value.excludes)) {
    input.excludes = value.excludes;
  }
  if (typeof value.limit === "number") {
    input.limit = value.limit;
  }
  if (typeof value.allowBackwardCrawling === "boolean") {
    input.allowBackwardCrawling = value.allowBackwardCrawling;
  }
  if (typeof value.allowExternalContentLinks === "boolean") {
    input.allowExternalContentLinks = value.allowExternalContentLinks;
  }
  if (typeof value.allowSubdomains === "boolean") {
    input.allowSubdomains = value.allowSubdomains;
  }
  if (typeof value.ignoreRobotsTxt === "boolean") {
    input.ignoreRobotsTxt = value.ignoreRobotsTxt;
  }
  if (typeof value.robotsUserAgent === "string") {
    input.robotsUserAgent = value.robotsUserAgent;
  }
  if (typeof value.sitemapOnly === "boolean") {
    input.sitemapOnly = value.sitemapOnly;
  }
  if (typeof value.ignoreSitemap === "boolean") {
    input.ignoreSitemap = value.ignoreSitemap;
  }
  if (typeof value.deduplicateSimilarURLs === "boolean") {
    input.deduplicateSimilarURLs = value.deduplicateSimilarURLs;
  }
  if (typeof value.ignoreQueryParameters === "boolean") {
    input.ignoreQueryParameters = value.ignoreQueryParameters;
  }
  if (typeof value.regexOnFullURL === "boolean") {
    input.regexOnFullURL = value.regexOnFullURL;
  }
  if (typeof value.maxDiscoveryDepth === "number") {
    input.maxDiscoveryDepth = value.maxDiscoveryDepth;
  }
  if (typeof value.delay === "number") {
    input.delay = value.delay;
  }
  return input;
}

export async function ongoingCrawlsController(
  req: RequestWithAuth<
    Record<string, string>,
    undefined,
    OngoingCrawlsResponse
  >,
  res: Response<OngoingCrawlsResponse>,
) {
  const ctx = requestContext({
    teamId: req.auth.team_id,
    zeroDataRetention: false,
    flags: req.acuc?.flags ?? null,
    orgId: req.acuc?.org_id ?? null,
    apiKeyId: req.acuc?.api_key_id ?? null,
    concurrencyLimit: req.acuc?.concurrency_limit,
    rateLimitMultiplier: req.acuc?.rate_limit_multiplier,
  });

  const ids = (
    await crawlGroup.getOngoingByOwner(req.auth.team_id, undefined, ctx)
  ).map(x => x.id);

  const fetched = await Promise.all(
    ids.map(async id => ({ crawl: await getCrawl(id), id })),
  );
  const crawls = fetched.flatMap(({ crawl, id }) => {
    if (!crawl || crawl.cancelled) {
      return [];
    }
    const rawOptions: unknown = crawl.crawlerOptions;
    const crawlerOptions = toStoredCrawlerOptionsInput(rawOptions);
    if (!crawlerOptions) {
      return [];
    }
    return [{ id, crawl, crawlerOptions }];
  });

  res.status(200).json({
    success: true,
    crawls: crawls.map(x => ({
      id: x.id,
      teamId: x.crawl.team_id,
      url: x.crawl.originUrl ?? "",
      created_at: new Date(x.crawl.createdAt || Date.now()).toISOString(),
      options: {
        ...toV2CrawlerOptions(x.crawlerOptions),
        scrapeOptions: x.crawl.scrapeOptions,
      },
    })),
  });
}
