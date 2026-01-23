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

function getStaleSeverity(elapsedMs: number): string | null {
  if (elapsedMs >= 300000) return "CRITICAL";
  if (elapsedMs >= 120000) return "HIGH";
  if (elapsedMs >= 60000) return "MEDIUM";
  if (elapsedMs >= 30000) return "LOW";
  return null;
}

async function getSitemapXML(options: SitemapScrapeOptions): Promise<string> {
  const logger = (options.logger ?? _logger).child({
    module: "sitemap",
    method: "getSitemapXML",
    crawlId: options.crawlId,
    sitemapUrl: options.url,
  });

  const startTime = Date.now();
  const isGzipped = options.url.toLowerCase().endsWith(".gz");

  logger.debug("Fetching sitemap XML", {
    maxAge: options.maxAge,
    isGzipped,
  });

  if (isGzipped) {
    const result = await _getSitemapXMLGZ(options);
    const durationMs = Date.now() - startTime;
    logger.debug("Gzipped sitemap fetched", { durationMs, xmlLength: result.length });
    return result;
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

  // Heartbeat interval to detect long-running sitemap fetches
  let heartbeatCount = 0;
  const heartbeatInterval = setInterval(() => {
    heartbeatCount++;
    const elapsedMs = Date.now() - startTime;
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    const severity = getStaleSeverity(elapsedMs);

    if (severity) {
      logger.warn("Sitemap fetch still in progress", {
        elapsedSeconds,
        elapsedMs,
        severity,
        heartbeatCount,
      });
    } else {
      logger.info("Sitemap fetch heartbeat", {
        elapsedSeconds,
        elapsedMs,
        heartbeatCount,
      });
    }
  }, 15000);

  try {
    logger.debug("Calling scrapeURL for sitemap");

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

    const durationMs = Date.now() - startTime;

    if (
      response.success &&
      response.document.metadata.statusCode >= 200 &&
      response.document.metadata.statusCode < 300
    ) {
      logger.info("scrapeURL for sitemap completed", {
        success: true,
        durationMs,
        statusCode: response.document.metadata.statusCode,
        htmlLength: response.document.rawHtml?.length ?? 0,
      });
      return response.document.rawHtml!;
    } else if (!response.success) {
      logger.error("scrapeURL for sitemap failed", {
        success: false,
        durationMs,
        error: response.error,
      });
      throw new SitemapError("Failed to scrape sitemap", response.error);
    } else {
      logger.error("scrapeURL for sitemap returned non-2xx status", {
        success: false,
        durationMs,
        statusCode: response.document.metadata.statusCode,
      });
      throw new SitemapError(
        "Failed to scrape sitemap",
        response.document.metadata.statusCode,
      );
    }
  } finally {
    clearInterval(heartbeatInterval);
    const totalDurationMs = Date.now() - startTime;
    logger.debug("getSitemapXML completed", { totalDurationMs });
  }
}

export async function scrapeSitemap(
  options: SitemapScrapeOptions,
): Promise<SitemapData> {
  const entryTime = Date.now();
  const logger = (options.logger ?? _logger).child({
    module: "crawler",
    method: "scrapeSitemap",
    crawlId: options.crawlId,
    sitemapUrl: options.url,
    zeroDataRetention: options.zeroDataRetention,
  });

  logger.info("Scraping sitemap - ENTRY", {
    maxAge: options.maxAge,
    location: options.location,
  });

  const fetchStartTime = Date.now();
  const xml = await getSitemapXML(options);
  const fetchDurationMs = Date.now() - fetchStartTime;

  logger.info("Sitemap XML fetched", {
    fetchDurationMs,
    xmlLength: xml.length,
  });

  const parseStartTime = Date.now();
  logger.debug("Processing sitemap XML");

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
      throw new SitemapError(errorMessage, error);
    }
    throw error;
  }

  const parseDurationMs = Date.now() - parseStartTime;
  logger.debug("Sitemap XML parsed", { parseDurationMs });

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

  const totalDurationMs = Date.now() - entryTime;
  logger.info("Processed sitemap - COMPLETE", {
    urls: sitemapData.urls.length,
    sitemaps: sitemapData.sitemaps.length,
    fetchDurationMs,
    parseDurationMs,
    totalDurationMs,
  });

  return sitemapData;
}
