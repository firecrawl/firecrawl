import { Response } from "express";
import { config } from "../../config";
import { v7 as uuidv7 } from "uuid";
import {
  MapDocument,
  mapRequestSchema,
  RequestWithAuth,
  TeamFlags,
} from "./types";
import { scrapeOptions, ScrapeOptions } from "../v2/types";
import { crawlToCrawler, StoredCrawl } from "../../lib/crawl-redis";
import { MapResponse, MapRequest, MAX_MAP_LIMIT } from "./types";
import { configDotenv } from "dotenv";
import {
  checkAndUpdateURLForMap,
  isSameDomain,
  isSameSubdomain,
  removeDuplicateUrls,
} from "../../lib/validateUrl";
import { fireEngineMap } from "../../search/fireEngine";
import { billTeam } from "../../services/billing/credit_billing";
import { logMap, logRequest } from "../../services/logging/log_job";
import { performCosineSimilarity } from "../../lib/map-cosine";
import { logger } from "../../lib/logger";
import Redis from "ioredis";
import {
  generateURLSplits,
  queryIndexAtDomainSplitLevel,
  queryIndexAtSplitLevel,
} from "../../services/index";
import { MapTimeoutError } from "../../lib/error";
import { checkPermissions } from "../../lib/permissions";

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

async function queryIndex(
  url: string,
  limit: number,
  useIndex: boolean,
  includeSubdomains: boolean,
): Promise<string[]> {
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
        ? queryIndexAtDomainSplitLevel(
            hostname,
            limit,
            14 * 24 * 60 * 60 * 1000,
          )
        : [],
      queryIndexAtSplitLevel(url, limit, 14 * 24 * 60 * 60 * 1000),
    ]);

    return Array.from(new Set([...domainLinks, ...splitLinks]));
  } else {
    return await queryIndexAtSplitLevel(url, limit);
  }
}

export async function getMapResults({
  url,
  search,
  limit = MAX_MAP_LIMIT,
  ignoreSitemap = false,
  includeSubdomains = true,
  crawlerOptions = {},
  teamId,
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
  const id = providedId ?? uuidv7();
  let links: string[] = [url];
  let mapResults: MapDocument[] = [];

  const zeroDataRetention = flags?.forceZDR || false;

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
    internalOptions: { teamId },
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

    const cacheKey = `fireEngineMap:${mapUrl}`;
    const cachedResult = ignoreCache ? null : await redis.get(cacheKey);

    let allResults: any[] = [];
    let pagePromises: Promise<any>[] = [];

    if (cachedResult) {
      allResults = JSON.parse(cachedResult);
    } else {
      const fetchPage = async (page: number) => {
        return fireEngineMap(
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
      links.push(...indexResults);
    }

    // If sitemap is not ignored, fetch sitemap
    // This will attempt to find it in the index at first, or fetch a fresh one if it's older than 2 days
    if (!ignoreSitemap) {
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
    time_taken: (new Date().getTime() - Date.now()) / 1000,
  };
}

export async function mapController(
  req: RequestWithAuth<{}, MapResponse, MapRequest>,
  res: Response<MapResponse>,
) {
  // Get timing data from middleware (includes all middleware processing time)
  const middlewareStartTime =
    (req as any).requestTiming?.startTime || new Date().getTime();
  const controllerStartTime = new Date().getTime();

  const originalRequest = req.body;
  req.body = mapRequestSchema.parse(req.body);

  if (req.acuc?.flags?.forceZDR) {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on map. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  const permissions = checkPermissions(req.body, req.acuc?.flags);
  if (permissions.error) {
    return res.status(403).json({
      success: false,
      error: permissions.error,
    });
  }

  const middlewareTime = controllerStartTime - middlewareStartTime;

  const mapId = uuidv7();

  logger.info("Map request", {
    request: req.body,
    originalRequest,
    teamId: req.auth.team_id,
    mapId,
  });

  await logRequest({
    id: mapId,
    kind: "map",
    api_version: "v1",
    team_id: req.auth.team_id,
    origin: req.body.origin ?? "api",
    integration: req.body.integration,
    target_hint: req.body.url,
    zeroDataRetention: false, // not supported for map
    api_key_id: req.acuc?.api_key_id ?? null,
  });

  let result: Awaited<ReturnType<typeof getMapResults>>;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const abort = new AbortController();
  try {
    result = (await Promise.race([
      getMapResults({
        url: req.body.url,
        search: req.body.search,
        limit: req.body.limit,
        ignoreSitemap: req.body.ignoreSitemap,
        includeSubdomains: req.body.includeSubdomains,
        crawlerOptions: req.body,
        origin: req.body.origin,
        teamId: req.auth.team_id,
        abort: abort.signal,
        mock: req.body.useMock,
        filterByPath: req.body.filterByPath !== false,
        flags: req.acuc?.flags ?? null,
        useIndex: req.body.useIndex,
        ignoreCache: req.body.ignoreCache,
        timeout: req.body.timeout,
        location: req.body.location,
        headers: req.body.headers,
        id: mapId,
      }),
      ...(req.body.timeout !== undefined
        ? [
            new Promise(
              (_resolve, reject) =>
                (timeoutHandle = setTimeout(() => {
                  abort.abort(new MapTimeoutError());
                  reject(new MapTimeoutError());
                }, req.body.timeout)),
            ),
          ]
        : []),
    ])) as any;
  } catch (error) {
    if (error instanceof MapTimeoutError) {
      return res.status(408).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    } else {
      throw error;
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  // Bill the team
  billTeam(
    req.auth.team_id,
    req.acuc?.sub_id,
    1,
    req.acuc?.api_key_id ?? null,
  ).catch(error => {
    logger.error(
      `Failed to bill team ${req.auth.team_id} for 1 credit: ${error}`,
    );
  });

  // Log the job
  logMap({
    id: result.job_id,
    request_id: result.job_id,
    url: req.body.url,
    team_id: req.auth.team_id,
    options: {
      search: req.body.search,
      limit: req.body.limit,
      ignoreSitemap: req.body.ignoreSitemap,
      includeSubdomains: req.body.includeSubdomains,
      filterByPath: req.body.filterByPath !== false,
      useIndex: req.body.useIndex,
      timeout: req.body.timeout,
      location: req.body.location,
    },
    results: result.links,
    credits_cost: 1,
    zeroDataRetention: false, // not supported
  });

  // Log final timing information
  const totalRequestTime = new Date().getTime() - middlewareStartTime;
  const controllerTime = new Date().getTime() - controllerStartTime;

  logger.info("Request metrics", {
    version: "v1",
    jobId: result.job_id,
    mode: "map",
    middlewareStartTime,
    controllerStartTime,
    middlewareTime,
    controllerTime,
    totalRequestTime,
    linksCount: result.links.length,
  });

  const response = {
    success: true as const,
    links: result.links,
    scrape_id: result.scrape_id,
  };

  return res.status(200).json(response);
}
