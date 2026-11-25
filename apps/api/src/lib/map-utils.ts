import { v7 as uuidv7 } from "uuid";
import {
  TeamFlags,
  MapDocument,
  scrapeOptions,
  ScrapeOptions,
  MAX_MAP_LIMIT,
} from "../controllers/v2/types";
import { crawlToCrawler, StoredCrawl } from "./crawl-redis";
import { getScrapeZDR, getSearchForcedKind } from "./zdr-helpers";
import { resolveSafeMode } from "./safe-mode";
import {
  checkAndUpdateURLForMap,
  isSameDomain,
  isSameSubdomain,
  resolveRedirects,
} from "./validateUrl";
import { fireEngineMap } from "../search/fireEngine";
import { isUsOnly } from "./us-only";
import { redisEvictConnection } from "../services/redis";
import {
  generateDomainSplits,
  generateURLSplits,
  queryIndexAtDomainSplitLevelWithMeta,
  queryIndexAtSplitLevelWithMeta,
} from "../services/index";
import { performCosineSimilarityV2 } from "./map-cosine";
import { Logger } from "winston";
import { requestContext } from "./request-context";
import type { RequestContext } from "../service/request-context";
import { installedService } from "../service/service";
import { scrapeURL, type InternalOptions } from "../scraper/scrapeURL";
import { CostTracking } from "./cost-tracking";
import { config } from "../config";
import { extractBaseDomain } from "./url-utils";

// Max Links that "Smart /map" can return
const MAX_FIRE_ENGINE_RESULTS = 100;
const START_PAGE_BUDGET_MS = 8_000;
const START_PAGE_BROWSER_WAIT_MS = 1_500;
const MAX_MAP_BROWSER_SCRAPES = 2;
const MAX_MAP_ROBOTS_ORIGINS = 8;
let activeMapBrowserScrapes = 0;

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

function startPageLinkKey(url: string): string {
  const { hostname, port, pathname, search } = new URL(url);
  return `${hostname.replace(/^www\./, "")}:${port}${pathname.replace(/\/$/, "")}${search}`;
}

async function scrapeMapStartPage(
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  deadline: number,
  waitFor = 0,
): Promise<{ url: string; links: string[] } | null> {
  const timeout = deadline - Date.now();
  if (
    timeout < 1_000 ||
    internalOptions.externalAbort?.signal.aborted ||
    (waitFor > 0 &&
      (!config.PLAYWRIGHT_MICROSERVICE_URL ||
        activeMapBrowserScrapes >= MAX_MAP_BROWSER_SCRAPES))
  ) {
    return null;
  }

  if (waitFor > 0) activeMapBrowserScrapes++;
  try {
    const result = await scrapeURL(
      uuidv7(),
      url,
      scrapeOptions.parse({
        ...options,
        formats: ["links"],
        onlyMainContent: false,
        storeInCache: false,
        proxy: "basic",
        timeout,
        waitFor: Math.min(waitFor, Math.floor(timeout / 2)),
      }),
      { ...internalOptions, forceEngine: waitFor > 0 ? "playwright" : "fetch" },
      new CostTracking(),
    );
    if (!result.success) return null;

    const {
      statusCode,
      contentType,
      url: landedUrl,
    } = result.document.metadata;
    if (
      statusCode < 200 ||
      statusCode >= 300 ||
      (contentType &&
        !/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType))
    ) {
      return null;
    }
    return { url: landedUrl ?? url, links: result.document.links ?? [] };
  } finally {
    if (waitFor > 0) activeMapBrowserScrapes--;
  }
}

export async function queryIndex(
  url: string,
  limit: number,
  useIndex: boolean,
  includeSubdomains: boolean,
): Promise<MapDocument[]> {
  if (!useIndex) {
    return [];
  }

  const urlSplits = generateURLSplits(url);
  if (urlSplits.length === 1 && includeSubdomains) {
    const hostname = new URL(urlSplits[0]).hostname;
    const domainSplits = generateDomainSplits(hostname);
    // domain_splits_0..4_hash cover hosts with a registrable domain up to 5
    // levels (excluding experimental __experimental_omceDomain overrides);
    // IP literals, localhost, and deeper subdomains fall back to url_split_0_hash.
    if (domainSplits.length > 0 && domainSplits.length <= 5) {
      return await queryIndexAtDomainSplitLevelWithMeta(hostname, limit);
    }
  }

  return await queryIndexAtSplitLevelWithMeta(url, limit);
}

interface MapScopeOptions {
  ignoreQueryParameters?: boolean;
  includeSubdomains?: boolean;
  filterByPath?: boolean;
  allowExternalLinks?: boolean;
}

function applyMapScope(
  documents: MapDocument[],
  baseUrl: string,
  {
    ignoreQueryParameters = true,
    includeSubdomains = true,
    filterByPath = true,
    allowExternalLinks = false,
  }: MapScopeOptions = {},
): MapDocument[] {
  let scoped = documents
    .map(x => {
      try {
        return {
          ...x,
          url: checkAndUpdateURLForMap(x.url, ignoreQueryParameters).url.trim(),
        };
      } catch (_) {
        return null;
      }
    })
    .filter((x): x is MapDocument => x !== null);

  scoped = scoped.filter(x => isSameDomain(x.url, baseUrl));

  if (!includeSubdomains) {
    scoped = scoped.filter(x => isSameSubdomain(x.url, baseUrl));
  }

  if (filterByPath && !allowExternalLinks) {
    try {
      const urlObj = new URL(baseUrl);
      const urlPath = urlObj.pathname;
      if (urlPath && urlPath !== "/" && urlPath.length > 1) {
        scoped = scoped.filter(x => {
          try {
            const linkObj = new URL(x.url);
            return linkObj.pathname.startsWith(urlPath);
          } catch {
            return false;
          }
        });
      }
    } catch {
      // If URL parsing fails, continue without path filtering
    }
  }

  return dedupeMapDocumentArray(scoped);
}

/**
 * Applies registered `map.collect` hooks to candidate map documents,
 * preserving existing metadata, reapplying map scope when provided,
 * deduplicating, and slicing to `limit`.
 */
export async function applyMapCollectHook(
  mapResults: MapDocument[],
  {
    ctx,
    url,
    limit,
    scope,
  }: {
    ctx: RequestContext;
    url: string;
    limit: number;
    scope?: MapScopeOptions;
  },
): Promise<MapDocument[]> {
  const hooks = installedService()?.hooks;
  if (!hooks?.has("map.collect")) {
    return mapResults;
  }
  const deduped = dedupeMapDocumentArray(mapResults);
  const currentUrls = deduped.map(doc => doc.url);
  const collectedUrls = await hooks.transform("map.collect", currentUrls, {
    ctx,
    url,
    limit,
  });
  const byUrl = new Map<string, MapDocument>();
  for (const doc of deduped) {
    byUrl.set(doc.url, doc);
  }
  const collectedDocs = collectedUrls.map(collectedUrl => {
    const existing = byUrl.get(collectedUrl);
    if (existing) {
      return existing;
    }
    if (scope) {
      try {
        const normalized = checkAndUpdateURLForMap(
          collectedUrl,
          scope.ignoreQueryParameters ?? true,
        ).url.trim();
        const normalizedExisting = byUrl.get(normalized);
        if (normalizedExisting) {
          return normalizedExisting;
        }
      } catch {
        // Invalid URL is dropped when applyMapScope runs below.
      }
    }
    return { url: collectedUrl };
  });
  const finalDocs = scope
    ? applyMapScope(collectedDocs, url, scope)
    : dedupeMapDocumentArray(collectedDocs);
  return finalDocs.slice(0, limit);
}

export async function getMapResults({
  url,
  search,
  limit = MAX_MAP_LIMIT,
  includeSubdomains = true,
  crawlerOptions = {},
  teamId,
  orgId,
  allowExternalLinks,
  abort = new AbortController().signal,
  mock,
  filterByPath = true,
  flags,
  useIndex = true,
  ignoreCache = false,
  location,
  headers,
  maxFireEngineResults = MAX_FIRE_ENGINE_RESULTS,
  id: providedId,
  zeroDataRetention: requestZeroDataRetention = false,
  ctx,
  startPageDiscovery,
}: {
  url: string;
  search?: string;
  limit?: number;
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
  flags: TeamFlags | null;
  useIndex?: boolean;
  ignoreCache?: boolean;
  location?: ScrapeOptions["location"];
  headers?: Record<string, string>;
  maxFireEngineResults?: number;
  id?: string;
  /** The calling request's own zero data retention, on top of the team's. */
  zeroDataRetention?: boolean;
  ctx?: RequestContext;
  startPageDiscovery?: Pick<InternalOptions, "threatProtection">;
}): Promise<MapResult> {
  const functionStartTime = Date.now();
  const startUrl = url;

  // Safe Mode lockdown: serve links from the index only — skip live search +
  // sitemap discovery. Derived here from the team flags so every caller
  // (map, extract, llmstxt, prompt enhancement) honors it.
  const indexOnly =
    resolveSafeMode(flags, undefined, url).safeMode?.lockdown === true;

  // Under lockdown (index-only) resolving redirects would HEAD/GET the target,
  // which the zero-outbound guarantee forbids — use the URL as given.
  const resolvedUrl = indexOnly
    ? url
    : await resolveRedirects(url, abort, mock);

  // If the resolved URL is on a different domain, replace the hostname
  if (!isSameDomain(url, resolvedUrl)) {
    const urlObj = new URL(url);
    urlObj.hostname = new URL(resolvedUrl).hostname;

    url = urlObj.toString();
  }

  const id = providedId ?? uuidv7();
  let mapResults: MapDocument[] = [];
  // Lockdown (index-only) is cache-only, which implies zero data retention —
  // and must never write its empty live-search result into the shared cache.
  const zeroDataRetention =
    requestZeroDataRetention || getScrapeZDR(flags) === "forced" || indexOnly;
  // The site search is a query sent to a search provider, so it also follows
  // the team's search zero data retention.
  const searchZeroDataRetention =
    zeroDataRetention || getSearchForcedKind(flags) === "zdr";

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
      ignoreCache ? 0 : undefined,
    );

    if (sitemap > 0) {
      mapResults = mapResults
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

    const usOnly = isUsOnly(flags);
    const cacheKey = `fireEngineMap:${usOnly ? "us-only:" : ""}${mapUrl}`;
    const cachedResult = ignoreCache
      ? null
      : await redisEvictConnection.get(cacheKey);

    const fetchPage = async (page: number) => {
      return await fireEngineMap(
        mapUrl,
        {
          numResults: resultsPerPage,
          page,
          usOnly,
          zeroDataRetention: searchZeroDataRetention,
        },
        abort,
      );
    };

    const fetchAllPages = async (): Promise<any[]> => {
      if (indexOnly) {
        // Lockdown: no live search discovery, serve from the index only.
        return [];
      }
      if (cachedResult) {
        return JSON.parse(cachedResult);
      }
      // if page 1 has no results, don't fetch remaining pages
      const page1Result = await fetchPage(1);
      if (!page1Result || page1Result.length === 0 || maxPages === 1) {
        return [page1Result];
      }
      const remainingPages = await Promise.all(
        Array.from({ length: maxPages - 1 }, (_, i) => fetchPage(i + 2)),
      );
      return [page1Result, ...remainingPages];
    };

    const [indexResults, searchResults] = await Promise.all([
      queryIndex(url, limit, useIndex, includeSubdomains),
      fetchAllPages(),
    ]);

    if (!searchZeroDataRetention) {
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

    if (crawlerOptions.sitemap === "include" && !indexOnly) {
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
          undefined,
          ignoreCache ? 0 : undefined,
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

  const scope: MapScopeOptions = {
    ignoreQueryParameters: crawlerOptions.ignoreQueryParameters ?? true,
    includeSubdomains,
    filterByPath,
    allowExternalLinks,
  };
  mapResults = applyMapScope(mapResults, url, scope);

  const discoveryBudget = Math.min(
    START_PAGE_BUDGET_MS,
    (crawlerOptions.timeout ?? 30_000) - (Date.now() - functionStartTime) - 100,
  );
  if (
    startPageDiscovery &&
    crawlerOptions.sitemap === "include" &&
    !search &&
    !indexOnly &&
    !abort.aborted &&
    discoveryBudget >= 1_000 &&
    mapResults.length < limit
  ) {
    const deadline = Date.now() + Math.ceil(discoveryBudget);
    const signal = AbortSignal.any([
      abort,
      AbortSignal.timeout(Math.ceil(discoveryBudget)),
    ]);
    const internalOptions: InternalOptions = {
      ...startPageDiscovery,
      teamId,
      orgId: orgId ?? null,
      teamFlags: flags,
      zeroDataRetention,
      bypassBilling: true,
      externalAbort: {
        signal,
        tier: "external",
        throwable: () => signal.reason,
      },
    };
    const startOrigin = new URL(startUrl).origin;
    const options = {
      ...sc.scrapeOptions,
      // A Map request's headers belong to the origin the caller supplied.
      headers:
        new URL(resolvedUrl).origin === startOrigin ? headers : undefined,
      ...(ignoreCache ? { maxAge: 0 } : {}),
      ...(crawlerOptions.useMock ? { useMock: crawlerOptions.useMock } : {}),
    };

    try {
      // Only named sites can share a domain across origins. For an IP or
      // single-label host, keep the scheme, host and port the caller supplied.
      const baseDomain = extractBaseDomain(startUrl) && extractBaseDomain(url);
      const scopedPath =
        filterByPath && !allowExternalLinks
          ? new URL(url).pathname.replace(/\/+$/, "")
          : "";

      const isInSite = (target: string) =>
        baseDomain
          ? extractBaseDomain(target) === baseDomain
          : URL.parse(target)?.origin === startOrigin;
      const robotsByOrigin = new Map<
        string,
        Promise<ReturnType<typeof crawlToCrawler>>
      >();
      if (sc.robots !== undefined) {
        robotsByOrigin.set(new URL(url).origin, Promise.resolve(crawler));
      }
      const isAllowedByRobots = async (target: string): Promise<boolean> => {
        if (signal.aborted) return false;
        const origin = new URL(target).origin;
        let rules = robotsByOrigin.get(origin);
        if (!rules) {
          if (robotsByOrigin.size >= MAX_MAP_ROBOTS_ORIGINS) return false;
          const originCrawler = crawlToCrawler(
            id,
            {
              ...sc,
              originUrl: origin,
              robots: undefined,
              scrapeOptions: { ...sc.scrapeOptions, headers: undefined },
            },
            flags,
          );
          rules = originCrawler.getRobotsTxt(false, signal).then(content => {
            originCrawler.importRobotsTxt(content);
            return originCrawler;
          });
          robotsByOrigin.set(origin, rules);
        }
        try {
          const originCrawler = await rules;
          return !signal.aborted && originCrawler.isRobotsAllowed(target);
        } catch {
          return false;
        }
      };
      const seedKeys = new Set(
        [startUrl, resolvedUrl].map(seed =>
          startPageLinkKey(
            checkAndUpdateURLForMap(
              seed,
              crawlerOptions.ignoreQueryParameters ?? true,
            ).url,
          ),
        ),
      );
      const existingKeys = new Set(
        mapResults.map(link => startPageLinkKey(link.url)),
      );
      const additionalLinks = async (page: {
        url: string;
        links: string[];
      }): Promise<MapDocument[] | null> => {
        if (!isInSite(page.url) || !(await isAllowedByRobots(page.url))) {
          return null;
        }
        const candidates = page.links.flatMap(link => {
          const target = URL.parse(link);
          if (
            !target ||
            !["http:", "https:"].includes(target.protocol) ||
            target.username ||
            target.password ||
            !isInSite(target.href) ||
            crawler.isFile(target.pathname) ||
            (scopedPath &&
              target.pathname !== scopedPath &&
              !target.pathname.startsWith(scopedPath + "/"))
          ) {
            return [];
          }
          target.hash = "";
          return [{ url: target.href }];
        });
        const seen = new Set([...seedKeys, ...existingKeys]);
        const extra: MapDocument[] = [];
        for (const link of applyMapScope(candidates, url, scope)) {
          const key = startPageLinkKey(link.url);
          if (seen.has(key)) continue;
          seen.add(key);
          if (await isAllowedByRobots(link.url)) extra.push(link);
          if (signal.aborted || mapResults.length + extra.length >= limit)
            break;
        }
        return extra;
      };

      const [startAllowed, resolvedAllowed] = await Promise.all([
        isAllowedByRobots(startUrl),
        isInSite(resolvedUrl) && isAllowedByRobots(resolvedUrl),
      ]);
      const page =
        startAllowed && resolvedAllowed
          ? await scrapeMapStartPage(
              resolvedUrl,
              options,
              internalOptions,
              deadline,
            )
          : null;
      let extra = page ? await additionalLinks(page) : null;
      if (extra !== null) {
        if (
          !extra.length &&
          mapResults.every(link => seedKeys.has(startPageLinkKey(link.url)))
        ) {
          const rendered = await scrapeMapStartPage(
            resolvedUrl,
            options,
            internalOptions,
            deadline,
            START_PAGE_BROWSER_WAIT_MS,
          );
          if (rendered) extra = (await additionalLinks(rendered)) ?? extra;
        }
        mapResults = mapResults.concat(extra).slice(0, limit);
      }
    } catch {
      // Optional discovery must not discard sitemap results.
    }
  }

  const hooks = installedService()?.hooks;
  if (hooks?.has("map.collect")) {
    const mapCtx =
      ctx ??
      requestContext({
        teamId,
        zeroDataRetention,
        flags: flags ?? undefined,
        orgId: orgId ?? null,
      });
    mapResults = await applyMapCollectHook(mapResults, {
      ctx: mapCtx,
      url,
      limit,
      scope,
    });
  } else {
    mapResults = mapResults.slice(0, limit);
  }

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
  orgId,
  flags,
  logger,
  limit = 50,
  includeSubdomains = true,
  allowExternalLinks = false,
  useIndex = true,
  maxFireEngineResults = 500,
  zeroDataRetention = false,
  ctx,
}: {
  basePrompt: string;
  url: string;
  teamId: string;
  orgId?: string | null;
  flags: TeamFlags | null;
  logger: Logger;
  limit?: number;
  includeSubdomains?: boolean;
  allowExternalLinks?: boolean;
  useIndex?: boolean;
  maxFireEngineResults?: number;
  zeroDataRetention?: boolean;
  ctx?: RequestContext;
}): Promise<{ prompt: string; websiteUrls: string[] }> {
  try {
    logger.debug("Getting website structure for prompt enhancement");
    const mapResult = await getMapResults({
      url,
      limit,
      includeSubdomains,
      crawlerOptions: { sitemap: "include" },
      teamId,
      orgId: orgId ?? null,
      flags,
      allowExternalLinks,
      filterByPath: false,
      useIndex,
      maxFireEngineResults,
      zeroDataRetention,
      ctx,
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
