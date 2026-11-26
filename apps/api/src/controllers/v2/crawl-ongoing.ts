import type { Response } from "express";
import { z } from "zod";
import type { OngoingCrawlsResponse, RequestWithAuth } from "./types";
import { toV2CrawlerOptions } from "./types";
import { getCrawl } from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
import { crawlGroup } from "../../services/worker/nuq-router";
import { requestContext } from "../../lib/request-context";
configDotenv();

type StoredCrawlerOptionsInput = Parameters<typeof toV2CrawlerOptions>[0];

function softOptional<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

const storedCrawlerOptionsSchema = z.object({
  includes: softOptional(z.array(z.string())),
  excludes: softOptional(z.array(z.string())),
  limit: softOptional(z.number()),
  allowBackwardCrawling: softOptional(z.boolean()),
  allowExternalContentLinks: softOptional(z.boolean()),
  allowSubdomains: softOptional(z.boolean()),
  ignoreRobotsTxt: softOptional(z.boolean()),
  robotsUserAgent: softOptional(z.string()),
  sitemapOnly: softOptional(z.boolean()),
  ignoreSitemap: softOptional(z.boolean()),
  deduplicateSimilarURLs: softOptional(z.boolean()),
  ignoreQueryParameters: softOptional(z.boolean()),
  regexOnFullURL: softOptional(z.boolean()),
  maxDiscoveryDepth: softOptional(z.number()),
  delay: softOptional(z.number()),
});

function toStoredCrawlerOptionsInput(
  value: unknown,
): StoredCrawlerOptionsInput | null {
  const parsed = storedCrawlerOptionsSchema.safeParse(value);
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
