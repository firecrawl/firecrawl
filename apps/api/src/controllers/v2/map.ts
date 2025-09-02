import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  mapRequestSchema,
  RequestWithAuth,
  scrapeOptions,
  ScrapeOptions,
  TeamFlags,
  MapRequest,
  MapDocument,
  MapResponse,
  MAX_MAP_LIMIT,
} from "./types";
import { crawlToCrawler, StoredCrawl } from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
import {
  checkAndUpdateURLForMap,
  isSameDomain,
  isSameSubdomain,
} from "../../lib/validateUrl";
import { fireEngineMap } from "../../search/fireEngine";
import { billTeam } from "../../services/billing/credit_billing";
import { logJob } from "../../services/logging/log_job";
import { logger } from "../../lib/logger";
import {
  generateURLSplits,
  queryIndexAtDomainSplitLevelWithMeta,
  queryIndexAtSplitLevelWithMeta,
} from "../../services/index";
import { redisEvictConnection } from "../../services/redis";
import { performCosineSimilarityV2 } from "../../lib/map-cosine";
import { MapTimeoutError } from "../../lib/error";

configDotenv();

// Max Links that "Smart /map" can return
const MAX_FIRE_ENGINE_RESULTS = 500;

interface MapResult {
  success: boolean;
  job_id: string;
  time_taken: number;
  mapResults: MapDocument[];
}

function dedupeMapDocumentArray(documents: MapDocument[]): MapDocument[] {
  let urlSet = new Set<string>(documents.map(x => x.url));

  let newDocuments: MapDocument[] = [
    ...Array.from(urlSet).map(x => {
      let localDocs = documents.filter(y => y.url === x);
      return localDocs.find(x => x.title !== undefined) || localDocs[0];
    }),
  ];

  return newDocuments;
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
  abort = new AbortController().signal, // noop
  filterByPath = true,
  flags,
  useIndex = true,
  location,
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
  flags: TeamFlags;
  useIndex?: boolean;
  location?: ScrapeOptions["location"];
}): Promise<MapResult> {
  const id = uuidv4();
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
  } catch (_) {}

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
      Math.min(MAX_FIRE_ENGINE_RESULTS, limit) / resultsPerPage,
    );

    const cacheKey = `fireEngineMap:${mapUrl}`;
    const cachedResult = await redisEvictConnection.get(cacheKey);

    let pagePromises: (Promise<any> | any)[];

    if (cachedResult) {
      pagePromises = JSON.parse(cachedResult);
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
    }

    // Parallelize sitemap index query with search results
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

    // If sitemap is not ignored, fetch sitemap
    // This will attempt to find it in the index at first, or fetch a fresh one if it's older than 2 days
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
        logger.warn("tryGetSitemap threw an error", { error: e });
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

    const minumumCutoff = Math.min(MAX_MAP_LIMIT, limit);
    if (mapResults.length > minumumCutoff) {
      mapResults = mapResults.slice(0, minumumCutoff);
    }

    if (search) {
      const searchQuery = search.toLowerCase();
      mapResults = performCosineSimilarityV2(mapResults, searchQuery);
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

    // allows for subdomains to be included
    mapResults = mapResults.filter(x => isSameDomain(x.url, url));

    // if includeSubdomains is false, filter out subdomains
    if (!includeSubdomains) {
      mapResults = mapResults.filter(x => isSameSubdomain(x.url, url));
    }

    // Filter by path if enabled
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
        logger.warn(`Failed to parse URL for path filtering: ${url}`, {
          error: e,
        });
      }
    }

    mapResults = dedupeMapDocumentArray(mapResults);
  }

  mapResults = mapResults.slice(0, limit);

  return {
    success: true,
    mapResults,
    job_id: id,
    time_taken: (new Date().getTime() - Date.now()) / 1000,
  };
}

export async function mapController(
  req: RequestWithAuth<{}, MapResponse, MapRequest>,
  res: Response<MapResponse>,
) {
  const originalRequest = req.body;
  req.body = mapRequestSchema.parse(req.body);

  logger.info("Map request", {
    request: req.body,
    originalRequest,
    teamId: req.auth.team_id,
  });

  let result: Awaited<ReturnType<typeof getMapResults>>;
  const abort = new AbortController();
  try {
    result = (await Promise.race([
      getMapResults({
        url: req.body.url,
        search: req.body.search,
        limit: req.body.limit,
        includeSubdomains: req.body.includeSubdomains,
        crawlerOptions: {
          ...req.body,
          sitemap: req.body.sitemap,
        },
        origin: req.body.origin,
        teamId: req.auth.team_id,
        abort: abort.signal,
        mock: req.body.useMock,
        filterByPath: req.body.filterByPath !== false,
        flags: req.acuc?.flags ?? null,
        useIndex: req.body.useIndex,
        location: req.body.location,
      }),
      ...(req.body.timeout !== undefined
        ? [
            new Promise((resolve, reject) =>
              setTimeout(() => {
                abort.abort(new MapTimeoutError());
                reject(new MapTimeoutError());
              }, req.body.timeout),
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
  }

  // Bill the team
  billTeam(
    req.auth.team_id,
    req.acuc?.sub_id ?? undefined,
    1,
    req.acuc?.api_key_id ?? null,
  ).catch(error => {
    logger.error(
      `Failed to bill team ${req.auth.team_id} for 1 credit: ${error}`,
    );
  });

  // Log the job
  logJob({
    job_id: result.job_id,
    success: result.mapResults.length > 0,
    message: "Map completed",
    num_docs: result.mapResults.length,
    docs: result.mapResults,
    time_taken: result.time_taken,
    team_id: req.auth.team_id,
    mode: "map",
    url: req.body.url,
    crawlerOptions: {},
    scrapeOptions: {},
    origin: req.body.origin ?? "api",
    integration: req.body.integration,
    num_tokens: 0,
    credits_billed: 1,
    zeroDataRetention: false, // not supported
  });

  const response = {
    success: true as const,
    links: result.mapResults,
  };

  return res.status(200).json(response);
}
