import { parseStringPromise } from "xml2js";
import { WebCrawler, SITEMAP_LIMIT } from "./crawler";
import { scrapeURL } from "../scrapeURL";
import {
  getV2RequestSchemas,
  scrapeOptionsAcceptsMaxAge,
} from "../../controllers/v2/types";
import type { Logger } from "winston";
import { CostTracking } from "../../lib/cost-tracking";
import { ScrapeJobTimeoutError } from "../../lib/error";
import type { ScrapeOptions } from "../../controllers/v2/types";
import type { Engine } from "../scrapeURL/engines";
import type { RequestContext } from "../../service/request-context";
import { installedService } from "../../service/service";
import type {
  ParsedSitemap,
  SitemapProcessingResult,
} from "@mendable/firecrawl-rs";
import { parseSitemapXml, processSitemap } from "@mendable/firecrawl-rs";
import { fetchFileToBuffer } from "../scrapeURL/engines/utils/downloadFile";
import { z } from "zod";
import {
  gunzipBounded,
  MAX_GUNZIPPED_FILE_SIZE,
} from "../scrapeURL/engines/utils/gunzip";

interface SitemapScrapeOptionsInput {
  formats: Array<string>;
  useMock?: string;
  maxAge?: number;
  location?: ScrapeOptions["location"];
  headers?: Record<string, string>;
}

const xml2jsSitemapEntrySchema = z.object({
  loc: z.array(z.unknown()),
});

const xml2jsUrlsetSchema = z.object({
  url: z.array(z.unknown()),
});

const xml2jsSitemapIndexSchema = z.object({
  sitemap: z.array(z.unknown()),
});

const xml2jsSitemapRootSchema = z.object({
  urlset: z.unknown().optional(),
  sitemapindex: z.unknown().optional(),
});

function extractSitemapEntries(
  items: ReadonlyArray<unknown>,
): Array<{ loc: Array<string> }> {
  const entries: Array<{ loc: Array<string> }> = [];
  for (const item of items) {
    const parsedItem = xml2jsSitemapEntrySchema.safeParse(item);
    if (!parsedItem.success) {
      continue;
    }
    const locs = parsedItem.data.loc.filter(loc => typeof loc === "string");
    if (locs.length > 0) {
      entries.push({ loc: locs });
    }
  }
  return entries;
}

function parseXml2jsSitemap(raw: unknown): ParsedSitemap {
  const parsed = xml2jsSitemapRootSchema.safeParse(raw);
  if (!parsed.success) {
    return {};
  }
  const result: ParsedSitemap = {};
  const parsedUrlset = xml2jsUrlsetSchema.safeParse(parsed.data.urlset);
  if (parsedUrlset.success) {
    result.urlset = { url: extractSitemapEntries(parsedUrlset.data.url) };
  }
  const parsedSitemapIndex = xml2jsSitemapIndexSchema.safeParse(
    parsed.data.sitemapindex,
  );
  if (parsedSitemapIndex.success) {
    result.sitemapindex = {
      sitemap: extractSitemapEntries(parsedSitemapIndex.data.sitemap),
    };
  }
  return result;
}

export async function getLinksFromSitemap(
  {
    sitemapUrl,
    urlsHandler,
    mode = "axios",
    maxAge = 0,
    zeroDataRetention,
    usOnly,
    location,
    headers,
  }: {
    sitemapUrl: string;
    urlsHandler: (urls: Array<string>) => void | Promise<void>;
    mode?: "axios" | "fire-engine";
    maxAge?: number;
    zeroDataRetention: boolean;
    usOnly?: boolean;
    location?: ScrapeOptions["location"];
    headers?: Record<string, string>;
  },
  logger: Logger,
  crawlId: string,
  sitemapsHit: Set<string>,
  abort?: AbortSignal,
  mock?: string,
): Promise<number> {
  if (sitemapsHit.size >= SITEMAP_LIMIT) {
    return 0;
  }

  if (sitemapsHit.has(sitemapUrl)) {
    logger.warn("This sitemap has already been hit.", { sitemapUrl });
    return 0;
  }

  sitemapsHit.add(sitemapUrl);

  try {
    let content = "";

    const isGzip = sitemapUrl.toLowerCase().endsWith(".gz");
    if (isGzip) {
      try {
        const { buffer } = await fetchFileToBuffer(
          sitemapUrl,
          false,
          { headers, signal: abort },
          MAX_GUNZIPPED_FILE_SIZE,
        );
        const decompressed = await gunzipBounded(buffer);
        content = decompressed.toString("utf8");
      } catch (error: unknown) {
        logger.error("Failed to download/decompress gzip sitemap", {
          sitemapUrl,
          error,
        });
        return 0;
      }
    } else {
      try {
        const forceEngine: Array<Engine> = ["fetch"];
        const parentCtx: RequestContext = {
          teamId: "sitemap",
          zeroDataRetention,
        };
        if (usOnly) {
          parentCtx.usOnly = true;
        }
        const systemCtx =
          installedService()?.modules.policy.system("sitemap", parentCtx) ??
          parentCtx;

        const schema = getV2RequestSchemas().scrapeOptions;
        const rawScrapeOptions: SitemapScrapeOptionsInput = {
          formats: ["rawHtml"],
          useMock: mock,
        };
        if (scrapeOptionsAcceptsMaxAge(schema) && maxAge !== undefined) {
          rawScrapeOptions.maxAge = maxAge;
        }
        if (location) {
          rawScrapeOptions.location = location;
        }
        if (headers) {
          rawScrapeOptions.headers = headers;
        }

        const response = await scrapeURL(
          "sitemap;" + crawlId,
          sitemapUrl,
          schema.parse(rawScrapeOptions),
          {
            ctx: systemCtx,
            forceEngine,
            sitemapFetch: mode === "fire-engine" ? "http" : "direct",
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
            teamId: systemCtx.teamId,
            zeroDataRetention: systemCtx.zeroDataRetention,
          },
          new CostTracking(),
        );

        if (
          response.success &&
          response.document.metadata.statusCode >= 200 &&
          response.document.metadata.statusCode < 300
        ) {
          content = response.document.rawHtml ?? "";
        } else {
          if (
            response.success &&
            response.document.metadata.statusCode === 404
          ) {
            logger.warn("Sitemap not found", { sitemapUrl }); // should probably index 404 sitemaps
            return 0;
          }

          const scrapeError: unknown = response.success
            ? response.document.metadata.statusCode
            : response.error;
          logger.error(`Request failed for sitemap fetch`, {
            method: "getLinksFromSitemap",
            mode,
            sitemapUrl,
            error: scrapeError,
          });
          return 0;
        }
      } catch (error: unknown) {
        if (error instanceof ScrapeJobTimeoutError) {
          throw error;
        } else {
          logger.error(`Request failed for sitemap fetch`, {
            method: "getLinksFromSitemap",
            mode,
            sitemapUrl,
            error,
          });
          return 0;
        }
      }
    }

    let instructions: SitemapProcessingResult;
    try {
      instructions = await processSitemap(content);
    } catch (error: unknown) {
      logger.warn(
        "Rust sitemap processing failed, falling back to JavaScript logic",
        {
          method: "getLinksFromSitemap",
          sitemapUrl,
          error: error instanceof Error ? error.message : String(error),
        },
      );

      let parsed: ParsedSitemap;
      try {
        parsed = await parseSitemapXml(content);
      } catch (parseError: unknown) {
        logger.warn(
          "Rust XML parsing failed, falling back to JavaScript logic",
          {
            method: "getLinksFromSitemap",
            sitemapUrl,
            error:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
          },
        );
        parsed = parseXml2jsSitemap(await parseStringPromise(content));
      }

      const root = parsed.urlset || parsed.sitemapindex;
      let count = 0;

      if (root && "sitemap" in root && root.sitemap) {
        const sitemapUrls = root.sitemap
          .filter(sitemap => sitemap.loc && sitemap.loc.length > 0)
          .map(sitemap => sitemap.loc[0].trim());

        const sitemapPromises: Array<Promise<number>> = sitemapUrls.map(
          sitemapUrl =>
            getLinksFromSitemap(
              {
                sitemapUrl,
                urlsHandler,
                mode,
                zeroDataRetention,
                usOnly,
                location,
                headers,
                maxAge,
              },
              logger,
              crawlId,
              sitemapsHit,
              abort,
              mock,
            ),
        );

        const results = await Promise.all(sitemapPromises);
        count = results.reduce((a, x) => a + x);
      } else if (root && "url" in root && root.url) {
        const xmlSitemaps: Array<string> = root.url
          .filter(
            url =>
              url.loc &&
              url.loc.length > 0 &&
              (url.loc[0].trim().toLowerCase().endsWith(".xml") ||
                url.loc[0].trim().toLowerCase().endsWith(".xml.gz")),
          )
          .map(url => url.loc[0].trim());

        if (xmlSitemaps.length > 0) {
          const sitemapPromises = xmlSitemaps.map(sitemapUrl =>
            getLinksFromSitemap(
              {
                sitemapUrl,
                urlsHandler,
                mode,
                zeroDataRetention,
                usOnly,
                location,
                headers,
                maxAge,
              },
              logger,
              crawlId,
              sitemapsHit,
              abort,
              mock,
            ),
          );
          count += (await Promise.all(sitemapPromises)).reduce(
            (a, x) => a + x,
            0,
          );
        }

        const validUrls = root.url
          .filter(
            url =>
              url.loc &&
              url.loc.length > 0 &&
              !url.loc[0].trim().toLowerCase().endsWith(".xml") &&
              !url.loc[0].trim().toLowerCase().endsWith(".xml.gz") &&
              !WebCrawler.prototype.isFile(url.loc[0].trim()),
          )
          .map(url => url.loc[0].trim());
        count += validUrls.length;

        const h = urlsHandler(validUrls);
        if (h instanceof Promise) {
          await h;
        }
      }

      return count;
    }

    let count = 0;
    for (const instruction of instructions.instructions) {
      if (instruction.action === "recurse") {
        const sitemapPromises: Array<Promise<number>> = instruction.urls.map(
          sitemapUrl =>
            getLinksFromSitemap(
              {
                sitemapUrl,
                urlsHandler,
                mode,
                zeroDataRetention,
                usOnly,
                location,
                headers,
                maxAge,
              },
              logger,
              crawlId,
              sitemapsHit,
              abort,
              mock,
            ),
        );

        const results = await Promise.all(sitemapPromises);
        count += results.reduce((a, x) => a + x, 0);
      } else if (instruction.action === "process") {
        count += instruction.urls.length;
        const h = urlsHandler(instruction.urls);
        if (h instanceof Promise) {
          await h;
        }
      }
    }

    return count;
  } catch (error: unknown) {
    logger.debug(`Error processing sitemapUrl: ${sitemapUrl}`, {
      method: "getLinksFromSitemap",
      mode,
      sitemapUrl,
      error,
    });
  }

  return 0;
}
