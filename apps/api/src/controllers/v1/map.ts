import { config } from "../../config";
import { v7 as uuidv7 } from "uuid";
import { MapDocument, TeamFlags } from "./types";
import { scrapeOptions, ScrapeOptions } from "../v2/types";
import { crawlToCrawler, StoredCrawl } from "../../lib/crawl-redis";
import { MAX_MAP_LIMIT } from "./types";
import { configDotenv } from "dotenv";
import {
  checkAndUpdateURLForMap,
  isSameDomain,
  isSameSubdomain,
  removeDuplicateUrls,
} from "../../lib/validateUrl";
import { fireEngineMap } from "../../search/fireEngine";
import { isUsOnly } from "../../lib/us-only";
import { performCosineSimilarity } from "../../lib/map-cosine";
import { logger } from "../../lib/logger";
import Redis from "ioredis";
import { queryIndex } from "../../lib/map-utils";
import { resolveSafeMode } from "../../lib/safe-mode";
import { getScrapeZDR, getSearchForcedKind } from "../../lib/zdr-helpers";

configDotenv();
const redis = new Redis(config.REDIS_URL!);

// Max Links that "Smart /map" can return
const MAX_FIRE_ENGINE_RESULTS = 500;

interface MapResult {
  success: boolean;
  links: string[];
  scrape_id?: string;
  job_id: string;
  time_taken: number;
  mapResults: MapDocument[];
}

export async function getMapResults({
  url,
  search,
  limit = MAX_MAP_LIMIT,
  ignoreSitemap = false,
  includeSubdomains = true,
  crawlerOptions = {},
  teamId,
  orgId,
  origin,
  includeMetadata = false,
  allowExternalLinks,
  abort = new AbortController().signal, // noop
  mock,
  filterByPath = true,
  flags,
  useIndex = true,
  ignoreCache = false,
  timeout,
  location,
  headers,
  id: providedId,
}: {
  url: string;
  search?: string;
  limit?: number;
  ignoreSitemap?: boolean;
  includeSubdomains?: boolean;
  crawlerOptions?: any;
  teamId: string;
  orgId?: string | null;
  origin?: string;
  includeMetadata?: boolean;
  allowExternalLinks?: boolean;
  abort?: AbortSignal;
  mock?: string;
  filterByPath?: boolean;
  flags: TeamFlags;
  useIndex?: boolean;
  ignoreCache?: boolean;
  timeout?: number;
  location?: ScrapeOptions["location"];
  headers?: Record<string, string>;
  id?: string;
}): Promise<MapResult> {
  const startTime = Date.now();
  const id = providedId ?? uuidv7();
  let links: string[] = [url];
  let mapResults: MapDocument[] = [];

  // Safe Mode lockdown: serve links from the index only — skip the live
  // fireEngineMap search and any sitemap fetch (both are live discovery).
  // Derived from the team flags so every caller honors it.
  const indexOnly =
    resolveSafeMode(flags, undefined, url).safeMode?.lockdown === true;

  // Lockdown (index-only) is cache-only, which implies zero data retention.
  // The site search is a query sent to a search provider, so it also follows
  // the team's search zero data retention.
  const zeroDataRetention =
    getScrapeZDR(flags) === "forced" ||
    getSearchForcedKind(flags) === "zdr" ||
    indexOnly;

  const sc: StoredCrawl = {
    originUrl: url,
    crawlerOptions: {
      ...crawlerOptions,
      limit: crawlerOptions.sitemapOnly ? 10000000 : limit,
      scrapeOptions: undefined,
    },
    scrapeOptions: scrapeOptions.parse({
      ...(location ? { location } : {}),
      ...(headers ? { headers } : {}),
    }),
    internalOptions: { teamId, orgId: orgId ?? null },
    team_id: teamId,
    createdAt: Date.now(),
  };

  const crawler = crawlToCrawler(id, sc, flags);

  try {
    sc.robots = await crawler.getRobotsTxt(false, abort);
    crawler.importRobotsTxt(sc.robots);
  } catch (_) {}

  // If sitemapOnly is true, only get links from sitemap
  if (crawlerOptions.sitemapOnly) {
    const sitemap = await crawler.tryGetSitemap(
      urls => {
        urls.forEach(x => {
          links.push(x);
        });
      },
      true,
      true,
      timeout ?? 30000,
      abort,
      mock,
      ignoreCache ? 0 : undefined,
    );
    if (sitemap > 0) {
      links = links
        .slice(1)
        .map(x => {
          try {
            return checkAndUpdateURLForMap(x).url.trim();
          } catch (_) {
            return null;
          }
        })
        .filter(x => x !== null) as string[];
      // links = links.slice(1, limit); // don't slice, unnecessary
    }
  } else {
    let urlWithoutWww = url.replace("www.", "");

    let mapUrl =
      search && allowExternalLinks
        ? `${search} ${urlWithoutWww}`
        : search
          ? `${search} site:${urlWithoutWww}`
          : `site:${url}`;

    const resultsPerPage = 100;
    const maxPages = Math.ceil(
      Math.min(MAX_FIRE_ENGINE_RESULTS, limit) / resultsPerPage,
    );

    const usOnly = isUsOnly(flags);
    const cacheKey = `fireEngineMap:${usOnly ? "us-only:" : ""}${mapUrl}`;
    const cachedResult = ignoreCache ? null : await redis.get(cacheKey);

    let allResults: any[] = [];
    let pagePromises: Promise<any>[] = [];

    if (indexOnly) {
      // Lockdown: no live search discovery, serve from the index only.
      allResults = [];
    } else if (cachedResult) {
      allResults = JSON.parse(cachedResult);
    } else {
      const fetchPage = async (page: number) => {
        return fireEngineMap(
          mapUrl,
          {
            numResults: resultsPerPage,
            page: page,
            usOnly,
            zeroDataRetention,
          },
          abort,
        );
      };

      pagePromises = Array.from({ length: maxPages }, (_, i) =>
        fetchPage(i + 1),
      );
      allResults = await Promise.all(pagePromises);

      if (!zeroDataRetention) {
        await redis.set(
          cacheKey,
          JSON.stringify(allResults),
          "EX",
          48 * 60 * 60,
        ); // Cache for 48 hours
      }
    }

    // Parallelize sitemap index query with search results
    const [indexResults, ...searchResults] = await Promise.all([
      queryIndex(url, limit, useIndex, includeSubdomains),
      ...(cachedResult ? [] : pagePromises),
    ]);

    if (indexResults.length > 0) {
      links.push(...indexResults.map(x => x.url));
    }

    // If sitemap is not ignored, fetch sitemap
    // This will attempt to find it in the index at first, or fetch a fresh one if it's older than 2 days
    if (!ignoreSitemap && !indexOnly) {
      try {
        await crawler.tryGetSitemap(
          urls => {
            links.push(...urls);
          },
          true,
          false,
          timeout ?? 30000,
          abort,
          undefined,
          ignoreCache ? 0 : undefined,
        );
      } catch (e) {
        logger.warn("tryGetSitemap threw an error", { error: e });
      }
    }

    if (!cachedResult) {
      allResults = searchResults;
    }

    mapResults = allResults
      .flat()
      .filter(result => result !== null && result !== undefined);

    const minumumCutoff = Math.min(MAX_MAP_LIMIT, limit);
    if (mapResults.length > minumumCutoff) {
      mapResults = mapResults.slice(0, minumumCutoff);
    }

    if (mapResults.length > 0) {
      if (search) {
        // Ensure all map results are first, maintaining their order
        links = [
          mapResults[0].url,
          ...mapResults.slice(1).map(x => x.url),
          ...links,
        ];
      } else {
        mapResults.map(x => {
          links.push(x.url);
        });
      }
    }

    // Perform cosine similarity between the search query and the list of links
    if (search) {
      const searchQuery = search.toLowerCase();
      links = performCosineSimilarity(links, searchQuery);
    }

    links = links
      .map(x => {
        try {
          return checkAndUpdateURLForMap(
            x,
            crawlerOptions.ignoreQueryParameters ?? true,
          ).url.trim();
        } catch (_) {
          return null;
        }
      })
      .filter(x => x !== null) as string[];

    // allows for subdomains to be included
    links = links.filter(x => isSameDomain(x, url));

    // if includeSubdomains is false, filter out subdomains
    if (!includeSubdomains) {
      links = links.filter(x => isSameSubdomain(x, url));
    }

    // Filter by path if enabled
    if (filterByPath && !allowExternalLinks) {
      try {
        const urlObj = new URL(url);
        const urlPath = urlObj.pathname;
        // Only apply path filtering if the URL has a significant path (not just '/' or empty)
        // This means we only filter by path if the user has not selected a root domain
        if (urlPath && urlPath !== "/" && urlPath.length > 1) {
          links = links.filter(link => {
            try {
              const linkObj = new URL(link);
              return linkObj.pathname.startsWith(urlPath);
            } catch (e) {
              return false;
            }
          });
        }
      } catch (e) {
        // If URL parsing fails, continue without path filtering
        logger.warn(`Failed to parse URL for path filtering: ${url}`, {
          error: e,
        });
      }
    }

    // remove duplicates that could be due to http/https or www
    links = removeDuplicateUrls(links);
  }

  const linksToReturn = crawlerOptions.sitemapOnly
    ? links
    : links.slice(0, limit);

  return {
    success: true,
    links: linksToReturn,
    mapResults: mapResults,
    scrape_id: origin?.includes("website") ? id : undefined,
    job_id: id,
    time_taken: (Date.now() - startTime) / 1000,
  };
}
