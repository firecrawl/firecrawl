import { parseStringPromise } from "xml2js";
import { WebCrawler, SITEMAP_LIMIT } from "./crawler";
import { scrapeURL } from "../scrapeURL";
import { scrapeOptions } from "../../controllers/v2/types";
import type { Logger } from "winston";
import { CostTracking } from "../../lib/cost-tracking";
import { ScrapeJobTimeoutError } from "../../lib/error";
import type { ScrapeOptions } from "../../controllers/v2/types";
import { Engine } from "../scrapeURL/engines";
import { useFireEngine } from "../scrapeURL/engines/fire-engine/available";
import {
  ParsedSitemap,
  parseSitemapXml,
  processSitemap,
  SitemapProcessingResult,
} from "@mendable/firecrawl-rs";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { fetchFileToBuffer } from "../scrapeURL/engines/utils/downloadFile";
import { useIndex } from "../../services";
import { withSitemapPermit } from "../sitemap-permit";

const gunzipAsync = promisify(gunzip);

type SitemapOptions = {
  sitemapUrl: string;
  urlsHandler(urls: string[]): unknown;
  mode?: "axios" | "fire-engine";
  maxAge?: number;
  zeroDataRetention: boolean;
  location?: ScrapeOptions["location"];
  headers?: Record<string, string>;
};

async function getSitemapInstructions(
  {
    sitemapUrl,
    mode = "axios",
    maxAge = 0,
    zeroDataRetention,
    location,
    headers,
  }: SitemapOptions,
  logger: Logger,
  crawlId: string,
  abort?: AbortSignal,
  mock?: string,
): Promise<SitemapProcessingResult | null> {
  let content = "";

  const isGzip = sitemapUrl.toLowerCase().endsWith(".gz");
  if (isGzip) {
    try {
      const { buffer } = await fetchFileToBuffer(sitemapUrl, false, {
        headers,
        signal: abort,
      });
      const decompressed = await gunzipAsync(buffer);
      content = decompressed.toString("utf-8");
    } catch (error) {
      logger.error("Failed to download/decompress gzip sitemap", {
        sitemapUrl,
        error,
      });
      return null;
    }
  } else {
    try {
      const shouldPrioritizeFireEngine =
        location && mode === "fire-engine" && useFireEngine;

      const forceEngine: Engine[] = [
        ...(maxAge > 0 && useIndex ? ["index" as const] : []),
        ...(shouldPrioritizeFireEngine
          ? [
              "fire-engine;tlsclient" as const,
              "fire-engine;tlsclient;stealth" as const,
            ]
          : []),
        "fetch",
        ...(!shouldPrioritizeFireEngine &&
        mode === "fire-engine" &&
        useFireEngine
          ? [
              "fire-engine;tlsclient" as const,
              "fire-engine;tlsclient;stealth" as const,
            ]
          : []),
      ];

      const response = await scrapeURL(
        "sitemap;" + crawlId,
        sitemapUrl,
        scrapeOptions.parse({
          formats: ["rawHtml"],
          useMock: mock,
          maxAge,
          ...(location ? { location } : {}),
          ...(headers ? { headers } : {}),
        }),
        {
          forceEngine,
          v0DisableJsDom: true,
          orgId: null,
          externalAbort: abort
            ? {
                signal: abort,
                tier: "external",
                throwable() {
                  return new Error("Sitemap fetch aborted");
                },
              }
            : undefined,
          teamId: "sitemap",
          zeroDataRetention,
        },
        new CostTracking(),
      );

      if (
        response.success &&
        response.document.metadata.statusCode >= 200 &&
        response.document.metadata.statusCode < 300
      ) {
        content = response.document.rawHtml!;
      } else {
        if (response.success && response.document.metadata.statusCode === 404) {
          logger.warn("Sitemap not found", { sitemapUrl }); // should probably index 404 sitemaps
          return null;
        }

        logger.error(`Request failed for sitemap fetch`, {
          method: "getLinksFromSitemap",
          mode,
          sitemapUrl,
          error: response.success
            ? response.document.metadata.statusCode
            : response.error,
        });
        return null;
      }
    } catch (error) {
      if (error instanceof ScrapeJobTimeoutError) {
        throw error;
      } else {
        logger.error(`Request failed for sitemap fetch`, {
          method: "getLinksFromSitemap",
          mode,
          sitemapUrl,
          error,
        });
        return null;
      }
    }
  }

  abort?.throwIfAborted();
  try {
    return await processSitemap(content);
  } catch (error) {
    logger.warn(
      "Rust sitemap processing failed, falling back to JavaScript logic",
      {
        method: "getLinksFromSitemap",
        sitemapUrl,
        error: error.message,
      },
    );
    abort?.throwIfAborted();
    let parsed: ParsedSitemap;
    try {
      parsed = await parseSitemapXml(content);
    } catch (parseError) {
      logger.warn("Rust XML parsing failed, falling back to JavaScript logic", {
        method: "getLinksFromSitemap",
        sitemapUrl,
        error: parseError.message,
      });
      abort?.throwIfAborted();
      parsed = await parseStringPromise(content);
    }

    const root = parsed.urlset || parsed.sitemapindex;
    const instructions: SitemapProcessingResult["instructions"] = [];
    if (root && "sitemap" in root && root.sitemap) {
      const urls = root.sitemap
        .filter(x => x.loc && x.loc.length > 0)
        .map(x => x.loc[0].trim());
      instructions.push({ action: "recurse", urls, count: urls.length });
    } else if (root && "url" in root && root.url) {
      const urls = root.url
        .filter(x => x.loc && x.loc.length > 0)
        .map(x => x.loc[0].trim());
      const isSitemap = (url: string) => /\.xml(?:\.gz)?$/i.test(url);
      const children = urls.filter(isSitemap);
      const pages = urls.filter(
        x => !isSitemap(x) && !WebCrawler.prototype.isFile(x),
      );
      instructions.push({
        action: "recurse",
        urls: children,
        count: children.length,
      });
      instructions.push({
        action: "process",
        urls: pages,
        count: pages.length,
      });
    }
    return {
      instructions,
      totalCount: instructions.reduce((sum, x) => sum + x.count, 0),
    };
  }
}

export async function getLinksFromSitemap(
  options: SitemapOptions,
  logger: Logger,
  crawlId: string,
  sitemapsHit: Set<string>,
  abort?: AbortSignal,
  mock?: string,
): Promise<number> {
  const { sitemapUrl, urlsHandler } = options;
  if (abort?.aborted || sitemapsHit.size >= SITEMAP_LIMIT) return 0;
  if (sitemapsHit.has(sitemapUrl)) {
    logger.warn("This sitemap has already been hit.", { sitemapUrl });
    return 0;
  }
  sitemapsHit.add(sitemapUrl);

  try {
    const result = await withSitemapPermit(
      () => getSitemapInstructions(options, logger, crawlId, abort, mock),
      abort,
    );
    if (!result || abort?.aborted) return 0;
    let count = 0;
    for (const instruction of result.instructions) {
      if (abort?.aborted) break;
      if (instruction.action === "recurse") {
        const counts = await Promise.all(
          instruction.urls.map(child =>
            getLinksFromSitemap(
              { ...options, sitemapUrl: child },
              logger,
              crawlId,
              sitemapsHit,
              abort,
              mock,
            ),
          ),
        );
        count += counts.reduce((sum, x) => sum + x, 0);
      } else if (instruction.action === "process") {
        await urlsHandler(instruction.urls);
        count += instruction.urls.length;
      }
    }
    return count;
  } catch (error) {
    if (!abort?.aborted)
      logger.debug(`Error processing sitemapUrl: ${sitemapUrl}`, {
        method: "getLinksFromSitemap",
        mode: options.mode ?? "axios",
        sitemapUrl,
        error,
      });
    return 0;
  }
}
