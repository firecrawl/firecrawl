import type { Logger } from "winston";
import { scrapeOptions, ScrapeOptions } from "../../controllers/v2/types";
import { logger as _logger } from "../../lib/logger";
import { Engine } from "../scrapeURL/engines";
import { scrapeURL } from "../scrapeURL";
import { CostTracking } from "../../lib/cost-tracking";
import { processSitemap } from "@mendable/firecrawl-rs";
import { fetchFileToBuffer } from "../scrapeURL/engines/utils/downloadFile";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const useFireEngine =
  process.env.FIRE_ENGINE_BETA_URL !== "" &&
  process.env.FIRE_ENGINE_BETA_URL !== undefined;

type SitemapScrapeOptions = {
  url: string;
  maxAge: number;
  zeroDataRetention: boolean;
  location: ScrapeOptions["location"];
  crawlId: string;
  logger?: Logger;
  isPreCrawl?: boolean;
};

type SitemapData = {
  urls: URL[];
  sitemaps: URL[];
};

const gunzipAsync = promisify(gunzip);

async function _getSitemapXMLGZ(
  options: SitemapScrapeOptions,
): Promise<string> {
  const { buffer } = await fetchFileToBuffer(options.url);
  const decompressed = await gunzipAsync(buffer);
  return decompressed.toString("utf-8");
}

async function getSitemapXML(options: SitemapScrapeOptions): Promise<string> {
  if (options.url.toLowerCase().endsWith(".gz")) {
    return await _getSitemapXMLGZ(options);
  }

  const isLocationSpecified =
    options.location && options.location.country !== "us-generic";

  const forceEngine: Engine[] = [
    ...(options.maxAge > 0 ? ["index" as const] : []),
    ...(isLocationSpecified && useFireEngine
      ? [
          "fire-engine;tlsclient" as const,
          "fire-engine;tlsclient;stealth" as const,
        ]
      : []),
    "fetch",
    ...(!isLocationSpecified && useFireEngine
      ? [
          "fire-engine;tlsclient" as const,
          "fire-engine;tlsclient;stealth" as const,
        ]
      : []),
  ];

  const response = await scrapeURL(
    "sitemap;" + options.crawlId,
    options.url,
    scrapeOptions.parse({
      formats: ["rawHtml"],
      maxAge: options.maxAge,
      ...(options.location ? { location: options.location } : {}),
    }),
    {
      forceEngine,
      v0DisableJsDom: true,
      // externalAbort: options.abort,
      teamId: "sitemap",
      zeroDataRetention: options.zeroDataRetention,
      crawlId: options.crawlId,
      isPreCrawl: options.isPreCrawl,
    },
    new CostTracking(),
  );

  if (
    response.success &&
    response.document.metadata.statusCode >= 200 &&
    response.document.metadata.statusCode < 300
  ) {
    return response.document.rawHtml!;
  } else if (!response.success) {
    throw new Error("Failed to scrape sitemap", { cause: response.error });
  } else {
    throw new Error("Failed to scrape sitemap", {
      cause: response.document.metadata.statusCode,
    });
  }
}

export async function scrapeSitemap(
  options: SitemapScrapeOptions,
): Promise<SitemapData> {
  const logger = (options.logger ?? _logger).child({
    module: "crawler",
    method: "scrapeSitemap",
    crawlId: options.crawlId,
    sitemapUrl: options.url,
    zeroDataRetention: options.zeroDataRetention,
  });

  logger.info("Scraping sitemap", {
    maxAge: options.maxAge,
    location: options.location,
  });

  const xml = await getSitemapXML(options);

  logger.info("Processing sitemap");

  const instructions = await processSitemap(xml);

  const sitemapData: SitemapData = {
    urls: [],
    sitemaps: [],
  };

  for (const instruction of instructions.instructions) {
    if (instruction.action === "recurse") {
      sitemapData.sitemaps.push(...instruction.urls.map(url => new URL(url)));
    } else if (instruction.action === "process") {
      sitemapData.urls.push(...instruction.urls.map(url => new URL(url)));
    }
  }

  logger.info("Processed sitemap", {
    urls: sitemapData.urls.length,
    sitemaps: sitemapData.sitemaps.length,
  });

  return sitemapData;
}
