import type { Logger } from "winston";
import { config } from "../../config";
import { scrapeOptions, ScrapeOptions } from "../../controllers/v2/types";
import { logger as _logger } from "../../lib/logger";
import { Engine } from "../scrapeURL/engines";
import { scrapeURL } from "../scrapeURL";
import { CostTracking } from "../../lib/cost-tracking";
import {
  processSitemap,
  SitemapProcessingResult,
} from "@mendable/firecrawl-rs";
import { fetchFileToBuffer } from "../scrapeURL/engines/utils/downloadFile";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { SitemapError } from "../../lib/error";
import { useIndex } from "../../services";

const useFireEngine =
  config.FIRE_ENGINE_BETA_URL !== "" &&
  config.FIRE_ENGINE_BETA_URL !== undefined;

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
    ...(options.maxAge > 0 && useIndex ? ["index" as const] : []),
    ...(isLocationSpecified && useFireEngine
      ? [
          "fire-engine;tlsclient" as const,
          "fire-engine;tlsclient;stealth" as const,
          // final fallback to chrome-cdp to fill the index
          "fire-engine;chrome-cdp" as const,
          "fire-engine;chrome-cdp;stealth" as const,
        ]
      : []),
    "fetch",
    ...(!isLocationSpecified && useFireEngine
      ? [
          "fire-engine;tlsclient" as const,
          "fire-engine;tlsclient;stealth" as const,
          // final fallback to chrome-cdp to fill the index
          "fire-engine;chrome-cdp" as const,
          "fire-engine;chrome-cdp;stealth" as const,
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
    throw new SitemapError(
      `Failed to fetch the sitemap from the website. The request failed with an error. This usually happens when: (1) The sitemap URL is incorrect, (2) The website is blocking access to the sitemap, (3) The website is down or unreachable, or (4) The sitemap requires authentication. Error details: ${response.error}`,
      response.error,
    );
  } else {
    throw new SitemapError(
      `Failed to fetch the sitemap from the website. The server returned HTTP status code ${response.document.metadata.statusCode}. This usually means: (1) The sitemap doesn't exist at this URL (404), (2) Access is forbidden (403), or (3) The server encountered an error (5xx). Verify the sitemap URL is correct and accessible.`,
      response.document.metadata.statusCode,
    );
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

  let instructions: SitemapProcessingResult;
  try {
    instructions = await processSitemap(xml);
  } catch (error) {
    // Wrap XML parsing errors (user's broken sitemap) in SitemapError
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes("XML parsing error") ||
      errorMessage.includes("Parse sitemap error")
    ) {
      throw new SitemapError(
        `The sitemap XML could not be parsed because it contains invalid or malformed XML. This is a problem with the website's sitemap, not with your request. Details: ${errorMessage}. The website owner should fix their sitemap to be valid XML. You can try using a different starting URL or the /map endpoint instead.`,
        error,
      );
    }
    throw error;
  }

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
