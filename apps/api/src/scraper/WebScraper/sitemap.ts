import { parseStringPromise } from "xml2js";
import { WebCrawler } from "./crawler";
import { scrapeURL } from "../scrapeURL";
import { scrapeOptions } from "../../controllers/v2/types";
import type { Logger } from "winston";
import { CostTracking } from "../../lib/extract/extraction-service";
import { parseSitemapXml, processSitemap } from "../../lib/crawler";
import { ScrapeJobTimeoutError } from "../../lib/error";
const useFireEngine =
  process.env.FIRE_ENGINE_BETA_URL !== "" &&
  process.env.FIRE_ENGINE_BETA_URL !== undefined;
export async function getLinksFromSitemap(
  {
    sitemapUrl,
    urlsHandler,
    mode = "axios",
    maxAge = 0,
    zeroDataRetention,
  }: {
    sitemapUrl: string;
    urlsHandler(urls: string[]): unknown;
    mode?: "axios" | "fire-engine";
    maxAge?: number;
    zeroDataRetention: boolean;
  },
  logger: Logger,
  crawlId: string,
  sitemapsHit: Set<string>,
  abort?: AbortSignal,
  mock?: string,
): Promise<number> {
  if (sitemapsHit.size >= 20) {
    return 0;
  }

  if (sitemapsHit.has(sitemapUrl)) {
    logger.warn("This sitemap has already been hit.", { sitemapUrl });
    return 0;
  }

  sitemapsHit.add(sitemapUrl);

  try {
    let content: string = "";
    try {
      const response = await scrapeURL(
        "sitemap;" + crawlId,
        sitemapUrl,
        scrapeOptions.parse({ formats: ["rawHtml"], useMock: mock, maxAge }),
        {
          forceEngine: [
            ...(maxAge > 0 ? ["index" as const] : []),
            "fetch",
            ...((mode === "fire-engine" && useFireEngine) ? ["fire-engine;tlsclient" as const, "fire-engine;tlsclient;stealth" as const] : []),
          ],
          v0DisableJsDom: true,
          externalAbort: abort ? {
            signal: abort,
            tier: "external",
            throwable() {
              return new Error("Sitemap fetch aborted");
            },
          } : undefined,
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
        logger.error(
          `Request failed for sitemap fetch`,
          {
            method: "getLinksFromSitemap",
            mode,
            sitemapUrl,
            error: response.success
              ? response.document.metadata.statusCode
              : response.error,
          },
        );
        return 0;
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
  
        return 0;
      }
    }

    let instructions;
    try {
      instructions = await processSitemap(content);
    } catch (error) {
      logger.warn("Rust sitemap processing failed, falling back to JavaScript logic", {
        method: "getLinksFromSitemap",
        sitemapUrl,
        error: error.message,
      });
      
      let parsed;
      try {
        parsed = await parseSitemapXml(content);
      } catch (parseError) {
        logger.warn("Rust XML parsing failed, falling back to JavaScript logic", {
          method: "getLinksFromSitemap",
          sitemapUrl,
          error: parseError.message,
        });
        parsed = await parseStringPromise(content);
      }
      
      const root = parsed.urlset || parsed.sitemapindex;
      let count = 0;

      if (root && root.sitemap) {
        const sitemapUrls = root.sitemap
          .filter((sitemap) => sitemap.loc && sitemap.loc.length > 0)
          .map((sitemap) => sitemap.loc[0].trim());

        const sitemapPromises: Promise<number>[] = sitemapUrls.map((sitemapUrl) =>
          getLinksFromSitemap({ sitemapUrl, urlsHandler, mode, zeroDataRetention }, logger, crawlId, sitemapsHit, abort, mock),
        );

        const results = await Promise.all(sitemapPromises);
        count = results.reduce((a, x) => a + x);
      } else if (root && root.url) {
        const xmlSitemaps: string[] = root.url
          .filter(
            (url) =>
              url.loc &&
              url.loc.length > 0 &&
              url.loc[0].trim().toLowerCase().endsWith(".xml"),
          )
          .map((url) => url.loc[0].trim());

        if (xmlSitemaps.length > 0) {
          const sitemapPromises = xmlSitemaps.map((sitemapUrl) =>
            getLinksFromSitemap(
              { sitemapUrl: sitemapUrl, urlsHandler, mode, zeroDataRetention },
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
            (url) =>
              url.loc &&
              url.loc.length > 0 &&
              !url.loc[0].trim().toLowerCase().endsWith(".xml") &&
              !WebCrawler.prototype.isFile(url.loc[0].trim()),
          )
          .map((url) => url.loc[0].trim());
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
        const sitemapPromises: Promise<number>[] = instruction.urls.map((sitemapUrl) =>
          getLinksFromSitemap({ sitemapUrl, urlsHandler, mode, zeroDataRetention }, logger, crawlId, sitemapsHit, abort, mock),
        );
        const results = await Promise.all(sitemapPromises);
        count += results.reduce((a, x) => a + x);
      } else if (instruction.action === "process") {
        count += instruction.urls.length;
        const h = urlsHandler(instruction.urls);
        if (h instanceof Promise) {
          await h;
        }
      }
    }

    return count;
  } catch (error) {
    logger.debug(`Error processing sitemapUrl: ${sitemapUrl}`, {
      method: "getLinksFromSitemap",
      mode,
      sitemapUrl,
      error,
    });
  }

  return 0;
}
