import { v7 as uuidv7 } from "uuid";
import {
  TeamFlags,
  MapDocument,
  scrapeOptions,
  ScrapeOptions,
  MAX_MAP_LIMIT,
} from "../controllers/v2/types";
import { crawlToCrawler, StoredCrawl } from "./crawl-redis";
import {
  checkAndUpdateURLForMap,
  isSameDomain,
  isSameSubdomain,
  resolveRedirects,
} from "./validateUrl";
import { fireEngineMap } from "../search/fireEngine";
import { redisEvictConnection } from "../services/redis";
import {
  generateURLSplits,
  queryIndexAtDomainSplitLevelWithMeta,
  queryIndexAtSplitLevelWithMeta,
} from "../services/index";
import { performCosineSimilarityV2 } from "./map-cosine";
import { Logger } from "winston";

// Max Links that "Smart /map" can return
const MAX_FIRE_ENGINE_RESULTS = 500;

export interface MapResult {
  success: boolean;
  job_id: string;
  time_taken: number;
  mapResults: MapDocument[];
}

function dedupeMapDocumentArray(documents: MapDocument[]): MapDocument[] {
  const urlMap = new Map<string, MapDocument>();

  for (const doc of documents) {
    const existing = urlMap.get(doc.url);

    if (!existing) {
      urlMap.set(doc.url, doc);
    } else if (doc.title !== undefined && existing.title === undefined) {
      urlMap.set(doc.url, doc);
    }
  }

  return Array.from(urlMap.values());
}

async function queryIndex(
  url: string,
  limit: number,
  useIndex: boolean,
  includeSubdomains: boolean,
): Promise<MapDocument[]> {
  if (!useIndex) {
    return [];
  }

  const urlSplits = generateURLSplits(url);
  if (urlSplits.length === 1) {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // TEMP: this should be altered on June 15th 2025 7AM PT - mogery
    const [domainLinks, splitLinks] = await Promise.all([
      includeSubdomains
        ? queryIndexAtDomainSplitLevelWithMeta(hostname, limit)
        : [],
      queryIndexAtSplitLevelWithMeta(url, limit),
    ]);

    return dedupeMapDocumentArray([...domainLinks, ...splitLinks]);
  } else {
    return await queryIndexAtSplitLevelWithMeta(url, limit);
  }
}

export async function getMapResults({
  url,
  search,
  limit = MAX_MAP_LIMIT,
  includeSubdomains = true,
  crawlerOptions = {},
  teamId,
  allowExternalLinks,
  abort = new AbortController().signal,
  filterByPath = true,
  flags,
  useIndex = true,
  location,
  maxFireEngineResults = MAX_FIRE_ENGINE_RESULTS,
}: {
  url: string;
  search?: string;
  limit?: number;
  includeSubdomains?: boolean;
  crawlerOptions?: any;
  teamId: string;
  origin?: string;
  includeMetadata?: boolean;
  allowExternalLinks?: boolean;
  abort?: AbortSignal;
  mock?: string;
  filterByPath?: boolean;
  flags: TeamFlags | null;
  useIndex?: boolean;
  location?: ScrapeOptions["location"];
  maxFireEngineResults?: number;
}): Promise<MapResult> {
  const functionStartTime = Date.now();

  const resolvedUrl = await resolveRedirects(url, abort);

  // If the resolved URL is on a different domain, replace the hostname
  if (!isSameDomain(url, resolvedUrl)) {
    const urlObj = new URL(url);
    urlObj.hostname = new URL(resolvedUrl).hostname;

    url = urlObj.toString();
  }

  const id = uuidv7();
  let mapResults: MapDocument[] = [];
  const zeroDataRetention = flags?.forceZDR ?? false;

  const sc: StoredCrawl = {
    originUrl: url,
    crawlerOptions: {
      ...crawlerOptions,
      limit: crawlerOptions.sitemapOnly ? 10000000 : limit,
      scrapeOptions: undefined,
    },
    scrapeOptions: scrapeOptions.parse({
      ...(location ? { location } : {}),
    }),
    internalOptions: { teamId },
    team_id: teamId,
    createdAt: Date.now(),
    zeroDataRetention,
  };

  const crawler = crawlToCrawler(id, sc, flags);

  try {
    sc.robots = await crawler.getRobotsTxt(false, abort);
    crawler.importRobotsTxt(sc.robots);
  } catch (_) {
    // Robots.txt fetch failed, continue without it
  }

  // If sitemapOnly is true, only get links from sitemap
  if (crawlerOptions.sitemap === "only") {
    const sitemap = await crawler.tryGetSitemap(
      urls => {
        urls.forEach(x => {
          mapResults.push({
            url: x,
          });
        });
      },
      true,
      true,
      crawlerOptions.timeout ?? 30000,
      abort,
      crawlerOptions.useMock,
    );

    if (sitemap > 0) {
      mapResults = mapResults
        .slice(1)
        .map(x => {
          try {
            return {
              ...x,
              url: checkAndUpdateURLForMap(x.url).url.trim(),
            };
          } catch (_) {
            return null;
          }
        })
        .filter(x => x !== null) as MapDocument[];
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
      Math.min(maxFireEngineResults, limit) / resultsPerPage,
    );

    const cacheKey = `fireEngineMap:${mapUrl}`;
    const cachedResult = await redisEvictConnection.get(cacheKey);

    let pagePromises: (Promise<any> | any)[];

    if (cachedResult) {
      pagePromises = JSON.parse(cachedResult);
    } else {
      const fetchPage = async (page: number) => {
        return await fireEngineMap(
          mapUrl,
          {
            numResults: resultsPerPage,
            page: page,
          },
          abort,
        );
      };

      pagePromises = Array.from({ length: maxPages }, (_, i) =>
        fetchPage(i + 1),
      );
    }

    const [indexResults, searchResults] = await Promise.all([
      queryIndex(url, limit, useIndex, includeSubdomains),
      Promise.all(pagePromises),
    ]);

    if (!zeroDataRetention) {
      await redisEvictConnection.set(
        cacheKey,
        JSON.stringify(searchResults),
        "EX",
        48 * 60 * 60,
      ); // Cache for 48 hours
    }

    if (indexResults.length > 0) {
      mapResults.push(...indexResults);
    }

    if (crawlerOptions.sitemap === "include") {
      try {
        await crawler.tryGetSitemap(
          urls => {
            mapResults.push(
              ...urls.map(x => ({
                url: x,
              })),
            );
          },
          true,
          false,
          crawlerOptions.timeout ?? 30000,
          abort,
        );
      } catch (e) {
        // Silently handle sitemap errors
      }
    }

    if (search) {
      mapResults = searchResults
        .flat()
        .map<MapDocument>(
          x =>
            ({
              url: x.url,
              title: x.title,
              description: x.description,
            }) satisfies MapDocument,
        )
        .concat(mapResults);
    } else {
      mapResults = mapResults.concat(
        searchResults.flat().map(x => ({
          url: x.url,
          title: x.title,
          description: x.description,
        })),
      );
    }

    const minimumCutoff = Math.min(MAX_MAP_LIMIT, limit);
    if (mapResults.length > minimumCutoff) {
      mapResults = mapResults.slice(0, minimumCutoff);
    }

    if (search) {
      const searchQuery = search.toLowerCase();
      mapResults = performCosineSimilarityV2(mapResults, searchQuery);
    }
  }

  mapResults = mapResults
    .map(x => {
      try {
        return {
          ...x,
          url: checkAndUpdateURLForMap(
            x.url,
            crawlerOptions.ignoreQueryParameters ?? true,
          ).url.trim(),
        };
      } catch (_) {
        return null;
      }
    })
    .filter(x => x !== null) as MapDocument[];

  mapResults = mapResults.filter(x => isSameDomain(x.url, url));

  if (!includeSubdomains) {
    mapResults = mapResults.filter(x => isSameSubdomain(x.url, url));
  }

  if (filterByPath && !allowExternalLinks) {
    try {
      const urlObj = new URL(url);
      const urlPath = urlObj.pathname;
      // Only apply path filtering if the URL has a significant path (not just '/' or empty)
      // This means we only filter by path if the user has not selected a root domain
      if (urlPath && urlPath !== "/" && urlPath.length > 1) {
        mapResults = mapResults.filter(x => {
          try {
            const linkObj = new URL(x.url);
            return linkObj.pathname.startsWith(urlPath);
          } catch (e) {
            return false;
          }
        });
      }
    } catch (e) {
      // If URL parsing fails, continue without path filtering
    }
  }

  mapResults = dedupeMapDocumentArray(mapResults);
  mapResults = mapResults.slice(0, limit);

  const totalTimeMs = Date.now() - functionStartTime;

  return {
    success: true,
    mapResults,
    job_id: id,
    time_taken: totalTimeMs,
  };
}

export async function buildPromptWithWebsiteStructure({
  basePrompt,
  url,
  teamId,
  flags,
  logger,
  limit = 50,
  includeSubdomains = true,
  allowExternalLinks = false,
  useIndex = true,
  maxFireEngineResults = 500,
}: {
  basePrompt: string;
  url: string;
  teamId: string;
  flags: TeamFlags | null;
  logger: Logger;
  limit?: number;
  includeSubdomains?: boolean;
  allowExternalLinks?: boolean;
  useIndex?: boolean;
  maxFireEngineResults?: number;
}): Promise<{ prompt: string; websiteUrls: string[] }> {
  try {
    logger.debug("Getting website structure for prompt enhancement");
    const mapResult = await getMapResults({
      url,
      limit,
      includeSubdomains,
      crawlerOptions: { sitemap: "include" },
      teamId,
      flags,
      allowExternalLinks,
      filterByPath: false,
      useIndex,
      maxFireEngineResults,
    });

    const websiteUrls = mapResult.mapResults.map(doc => doc.url);
    logger.debug("Found website URLs for prompt enhancement", {
      urlCount: websiteUrls.length,
      sampleUrls: websiteUrls.slice(0, 5),
    });

    const prompt = `${basePrompt}\n\n--- WEBSITE STRUCTURE ---\nThe website has the following URL structure (${websiteUrls.length} URLs found, here is a sample of the first ${Math.min(
      120,
      websiteUrls.length,
    )} URLs):\n${websiteUrls.slice(0, 120).join("\n")}\n\nBased on this structure and the user's request, generate appropriate crawler options.`;

    return { prompt, websiteUrls };
  } catch (e) {
    logger.warn("Failed to get website structure for prompt enhancement", {
      error: (e as any)?.message ?? e,
    });
    return { prompt: basePrompt, websiteUrls: [] };
  }
}
