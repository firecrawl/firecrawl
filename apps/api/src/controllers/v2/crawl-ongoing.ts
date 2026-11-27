import type { Response } from "express";
import { z } from "zod";
import type { OngoingCrawlsResponse, RequestWithAuth } from "./types";
import { toV2CrawlerOptions } from "./types";
import { getCrawl } from "../../lib/crawl-redis";
import { safeParseLogged, zCatchLogged } from "../../lib/zod-log";
import { configDotenv } from "dotenv";
import { crawlGroup } from "../../services/worker/nuq-router";
import { requestContext } from "../../lib/request-context";
configDotenv();

type StoredCrawlerOptionsInput = Parameters<typeof toV2CrawlerOptions>[0];

function softOptional<T extends z.ZodType>(schema: T, field: string) {
  return zCatchLogged(
    schema
      .nullable()
      .transform(value => value ?? undefined)
      .optional(),
    undefined,
    `crawl-ongoing.crawlerOptions.${field}`,
  );
}

const storedCrawlerOptionsSchema = z.object({
  includes: softOptional(z.array(z.string()), "includes"),
  excludes: softOptional(z.array(z.string()), "excludes"),
  limit: softOptional(z.number(), "limit"),
  allowBackwardCrawling: softOptional(z.boolean(), "allowBackwardCrawling"),
  allowExternalContentLinks: softOptional(
    z.boolean(),
    "allowExternalContentLinks",
  ),
  allowSubdomains: softOptional(z.boolean(), "allowSubdomains"),
  ignoreRobotsTxt: softOptional(z.boolean(), "ignoreRobotsTxt"),
  robotsUserAgent: softOptional(z.string(), "robotsUserAgent"),
  sitemapOnly: softOptional(z.boolean(), "sitemapOnly"),
  ignoreSitemap: softOptional(z.boolean(), "ignoreSitemap"),
  deduplicateSimilarURLs: softOptional(z.boolean(), "deduplicateSimilarURLs"),
  ignoreQueryParameters: softOptional(z.boolean(), "ignoreQueryParameters"),
  regexOnFullURL: softOptional(z.boolean(), "regexOnFullURL"),
  maxDiscoveryDepth: softOptional(z.number(), "maxDiscoveryDepth"),
  delay: softOptional(z.number(), "delay"),
});

function toStoredCrawlerOptionsInput(
  value: unknown,
): StoredCrawlerOptionsInput | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = safeParseLogged(
    storedCrawlerOptionsSchema,
    value,
    "crawl-ongoing.crawlerOptions",
  );
  return parsed.success ? parsed.data : null;
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
