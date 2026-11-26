import { v7 as uuidv7 } from "uuid";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  TeamFlags,
  MapDocument,
  scrapeOptions,
  ScrapeOptions,
  MAX_MAP_LIMIT,
} from "../controllers/v2/types";
import { crawlToCrawler, StoredCrawl } from "./crawl-redis";
import { checkAndUpdateURLForMap, resolveRedirects } from "./validateUrl";
import { performCosineSimilarityV2 } from "./map-cosine";
import { Logger } from "winston";
import { requestContext } from "./request-context";
import type { RequestContext } from "../service/request-context";
import { installedService } from "../service/service";
import { scrapeURL, type InternalOptions } from "../scraper/scrapeURL";
import { CostTracking } from "./cost-tracking";
import { config } from "../config";
import { extractBaseDomain } from "./url-utils";

const MAX_SEARCH_RESULTS = 100;
const MAX_SITEMAP_BUDGET_MS = 8_000;
const START_PAGE_BUDGET_MS = 10_000;
const START_PAGE_BROWSER_WAIT_MS = 2_000;
const DEFAULT_MAP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_MAP_BROWSER_SCRAPES = Math.max(
  1,
  Number.parseInt(process.env.MAP_MAX_BROWSER_SCRAPES ?? "2", 10) || 2,
);
const MAP_BROWSER_WAIT_MS = Math.max(
  0,
  Number.parseInt(process.env.MAP_BROWSER_WAIT_MS ?? "0", 10) || 0,
);
const MAX_MAP_ROBOTS_ORIGINS = 8;
const MIN_VERIFIED_SINGLE_PAGE_CHARS = 120;
const CHALLENGE_MARKERS = [
  "just a moment",
  "verify you are human",
  "checking your browser",
  "client challenge",
  "access denied",
  "attention required",
  "enable javascript",
  "please enable cookies",
  "page not found",
  "404 not found",
  "application error: a client-side exception",
  "application error: a server-side exception",
  "this site can't be reached",
  "a required part of this site couldn't load",
  "a required part of this site couldn’t load",
];
let activeMapBrowserScrapes = 0;
const mapBrowserWaitQueue: Array<() => void> = [];

function acquireMapBrowserPermit(
  signal: AbortSignal | undefined,
  maxWaitMs: number,
): Promise<(() => void) | null> {
  if (signal?.aborted) return Promise.resolve(null);
  const release = () => {
    activeMapBrowserScrapes--;
    while (
      activeMapBrowserScrapes < MAX_MAP_BROWSER_SCRAPES &&
      mapBrowserWaitQueue.length > 0
    ) {
      const wake = mapBrowserWaitQueue.shift();
      if (wake) {
        activeMapBrowserScrapes++;
        wake();
      }
    }
  };
  if (activeMapBrowserScrapes < MAX_MAP_BROWSER_SCRAPES) {
    activeMapBrowserScrapes++;
    return Promise.resolve(release);
  }
  const waitMs = Math.min(MAP_BROWSER_WAIT_MS, maxWaitMs);
  if (waitMs <= 0) {
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    const waitSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(waitMs)])
      : AbortSignal.timeout(waitMs);
    const grant = () => {
      waitSignal.removeEventListener("abort", cancel);
      resolve(release);
    };
    const cancel = () => {
      const idx = mapBrowserWaitQueue.indexOf(grant);
      if (idx !== -1) mapBrowserWaitQueue.splice(idx, 1);
      resolve(null);
    };
    if (waitSignal.aborted) {
      resolve(null);
      return;
    }
    mapBrowserWaitQueue.push(grant);
    waitSignal.addEventListener("abort", cancel, { once: true });
  });
}

export type MapDiscoveryOutcome =
  | "links_found"
  | "verified_single_page"
  | "dns_error"
  | "http_not_found"
  | "ssl_error"
  | "robots_disallowed"
  | "blocked_or_challenge"
  | "http_error"
  | "unsupported_file"
  | "timeout";

export interface MapDiscoveryInfo {
  outcome: MapDiscoveryOutcome;
  statusCode?: number;
  landedUrl?: string;
}

export interface MapResult {
  success: boolean;
  job_id: string;
  time_taken: number;
  mapResults: MapDocument[];
  state?: Record<string, unknown>;
  discovery?: MapDiscoveryInfo;
}

function isSameMapSite(candidate: string, base: string): boolean {
  const baseDomain = extractBaseDomain(base);
  if (baseDomain) {
    return extractBaseDomain(candidate) === baseDomain;
  }
  const baseParsed = URL.parse(base);
  const candidateParsed = URL.parse(candidate);
  return Boolean(
    baseParsed &&
      candidateParsed &&
      candidateParsed.origin === baseParsed.origin,
  );
}

function isSameMapSubdomain(candidate: string, base: string): boolean {
  const cHost = URL.parse(candidate)
    ?.hostname.replace(/^www\./i, "")
    .toLowerCase();
  const bHost = URL.parse(base)
    ?.hostname.replace(/^www\./i, "")
    .toLowerCase();
  return Boolean(cHost && bHost && cHost === bHost);
}

function isMapUtilityPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return (
    lower === "/cdn-cgi" ||
    lower.startsWith("/cdn-cgi/") ||
    lower === "/_next" ||
    lower.startsWith("/_next/")
  );
}

function withDefaultMapUserAgent(
  headers?: Record<string, string>,
): Record<string, string> {
  if (
    headers &&
    Object.keys(headers).some(key => key.toLowerCase() === "user-agent")
  ) {
    return headers;
  }
  return { "User-Agent": DEFAULT_MAP_USER_AGENT, ...(headers ?? {}) };
}

function isVerifiedCleanSinglePage(rawHtml: string, title?: string): boolean {
  const visible = rawHtml
    .replace(
      /<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|#160|#xA0);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (visible.length < MIN_VERIFIED_SINGLE_PAGE_CHARS) {
    return false;
  }
  const lowerTitle = (title ?? "").toLowerCase();
  const lowerHead = visible.slice(0, 2_000).toLowerCase();
  return !CHALLENGE_MARKERS.some(
    marker => lowerTitle.includes(marker) || lowerHead.includes(marker),
  );
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

type StartPageAttempt =
  | {
      kind: "html";
      url: string;
      statusCode: number;
      title?: string;
      description?: string;
      rawHtml: string;
      links: string[];
    }
  | {
      kind: "failed";
      reason:
        | "dns_error"
        | "http_not_found"
        | "ssl_error"
        | "unsupported_file"
        | "blocked_status"
        | "http_error"
        | "timeout"
        | "permit_busy"
        | "transport_error";
      statusCode?: number;
      url?: string;
    };

async function scrapeMapStartPage(
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  deadline: number,
  waitFor = 0,
  isFilePath?: (pathname: string) => boolean,
): Promise<StartPageAttempt> {
  const initialRemaining = Math.floor(deadline - Date.now());
  if (
    initialRemaining < 1_000 ||
    internalOptions.externalAbort?.signal.aborted
  ) {
    return { kind: "failed", reason: "timeout" };
  }
  if (waitFor > 0 && !config.PLAYWRIGHT_MICROSERVICE_URL) {
    return { kind: "failed", reason: "permit_busy" };
  }

  let releasePermit: (() => void) | null = null;
  if (waitFor > 0) {
    releasePermit = await acquireMapBrowserPermit(
      internalOptions.externalAbort?.signal,
      Math.max(0, initialRemaining - 2_000),
    );
    if (!releasePermit) {
      return {
        kind: "failed",
        reason: internalOptions.externalAbort?.signal.aborted
          ? "timeout"
          : "permit_busy",
      };
    }
  }

  try {
    const timeout = Math.floor(deadline - Date.now());
    if (timeout < 1_000 || internalOptions.externalAbort?.signal.aborted) {
      return { kind: "failed", reason: "timeout" };
    }
    const requestHeaders =
      waitFor > 0 ? options.headers : withDefaultMapUserAgent(options.headers);
    const result = await scrapeURL(
      uuidv7(),
      url,
      scrapeOptions.parse({
        ...options,
        ...(requestHeaders ? { headers: requestHeaders } : {}),
        formats: ["links", "rawHtml"],
        onlyMainContent: false,
        proxy: "basic",
        timeout,
        waitFor: Math.min(waitFor, Math.floor(timeout / 2)),
      }),
      { ...internalOptions, forceEngine: waitFor > 0 ? "playwright" : "fetch" },
      new CostTracking(),
    );
    if (!result.success) {
      const code = String((result.error as any)?.code ?? "");
      const message = String(
        (result.error as any)?.message ?? result.error ?? "",
      );
      if (/\bENOTFOUND\b/i.test(message)) {
        return { kind: "failed", reason: "dns_error" };
      }
      if (
        code === "SCRAPE_DNS_RESOLUTION_ERROR" ||
        (waitFor === 0 && code === "SCRAPE_ALL_ENGINES_FAILED")
      ) {
        try {
          await dnsLookup(new URL(url).hostname);
        } catch (dnsError: any) {
          if (dnsError?.code === "ENOTFOUND") {
            return { kind: "failed", reason: "dns_error" };
          }
        }
      }
      if (code === "SCRAPE_SSL_ERROR") {
        return { kind: "failed", reason: "ssl_error" };
      }
      if (code === "SCRAPE_UNSUPPORTED_FILE_ERROR") {
        return { kind: "failed", reason: "unsupported_file" };
      }
      if (
        code === "SCRAPE_TIMEOUT" ||
        internalOptions.externalAbort?.signal.aborted
      ) {
        return { kind: "failed", reason: "timeout" };
      }
      return { kind: "failed", reason: "transport_error" };
    }

    const {
      statusCode,
      contentType,
      url: landedUrl,
      title,
      description,
    } = result.document.metadata;
    const effectiveUrl = landedUrl ?? url;
    if (statusCode === 404 || statusCode === 410) {
      return {
        kind: "failed",
        reason: "http_not_found",
        statusCode,
        url: effectiveUrl,
      };
    }
    if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
      return {
        kind: "failed",
        reason: "blocked_status",
        statusCode,
        url: effectiveUrl,
      };
    }
    if (statusCode < 200 || statusCode >= 300) {
      return {
        kind: "failed",
        reason: "http_error",
        statusCode,
        url: effectiveUrl,
      };
    }
    const effectivePathname = URL.parse(effectiveUrl)?.pathname;
    if (
      (contentType &&
        !/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) ||
      (!contentType &&
        Boolean(effectivePathname && isFilePath?.(effectivePathname)))
    ) {
      return {
        kind: "failed",
        reason: "unsupported_file",
        statusCode,
        url: effectiveUrl,
      };
    }
    return {
      kind: "html",
      url: effectiveUrl,
      statusCode,
      title: typeof title === "string" ? title : undefined,
      description: typeof description === "string" ? description : undefined,
      rawHtml: result.document.rawHtml ?? "",
      links: result.document.links ?? [],
    };
  } finally {
    releasePermit?.();
  }
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

  scoped = scoped.filter(x => isSameMapSite(x.url, baseUrl));

  if (!includeSubdomains) {
    scoped = scoped.filter(x => isSameMapSubdomain(x.url, baseUrl));
  }

  if (filterByPath && !allowExternalLinks) {
    try {
      const urlObj = new URL(baseUrl);
      const urlPath = urlObj.pathname.replace(/\/+$/, "");
      if (urlPath && urlPath !== "/") {
        scoped = scoped.filter(x => {
          try {
            const linkObj = new URL(x.url);
            return (
              linkObj.pathname === urlPath ||
              linkObj.pathname.startsWith(urlPath + "/")
            );
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
 * Applies registered `map.filter` hooks to scoped, sorted, and limit-sliced
 * map documents.
 */
export async function applyMapFilterHook(
  mapResults: MapDocument[],
  {
    ctx,
    url,
    limit,
    state,
    logger,
  }: {
    ctx: RequestContext;
    url: string;
    limit: number;
    state?: Record<string, unknown>;
    logger?: Logger;
  },
): Promise<MapDocument[]> {
  const hooks = installedService()?.hooks;
  if (!hooks?.has("map.filter")) {
    return mapResults;
  }
  return await hooks.transform("map.filter", mapResults, {
    ctx,
    url,
    limit,
    ...(state !== undefined ? { state } : {}),
    ...(logger !== undefined ? { logger } : {}),
  });
}

/**
 * Applies registered `map.collect` hooks to candidate map documents,
 * preserving existing metadata, reapplying map scope when provided,
 * deduplicating, slicing to `limit`, and applying registered `map.filter`
 * hooks post-scope and post-limit.
 */
export async function applyMapCollectHook(
  mapResults: MapDocument[],
  {
    ctx,
    url,
    limit,
    scope,
    search,
    includeSubdomains,
    allowExternalLinks,
    ignoreCache,
    sitemap,
    useIndex,
    maxSearchResults,
    abort,
    state,
    logger,
  }: {
    ctx: RequestContext;
    url: string;
    limit: number;
    scope?: MapScopeOptions;
    search?: string;
    includeSubdomains?: boolean;
    allowExternalLinks?: boolean;
    ignoreCache?: boolean;
    sitemap?: "skip" | "include" | "only";
    useIndex?: boolean;
    maxSearchResults?: number;
    abort?: AbortSignal;
    state?: Record<string, unknown>;
    logger?: Logger;
  },
): Promise<MapDocument[]> {
  const hooks = installedService()?.hooks;
  const skipDiscovery = state?.skipDiscovery === true;
  const runCollect = Boolean(hooks?.has("map.collect")) && !skipDiscovery;
  if (!runCollect && !hooks?.has("map.filter") && !skipDiscovery) {
    return mapResults;
  }

  let candidateDocs = mapResults;
  if (runCollect) {
    const deduped = dedupeMapDocumentArray(mapResults);
    const currentUrls = deduped.map(doc => doc.url);
    const documents = new Map<string, MapDocument>();
    for (const doc of deduped) {
      documents.set(doc.url, doc);
    }
    const collectedUrls = await hooks!.transform("map.collect", currentUrls, {
      ctx,
      url,
      limit,
      ...(search !== undefined ? { search } : {}),
      ...(includeSubdomains !== undefined ? { includeSubdomains } : {}),
      ...(allowExternalLinks !== undefined ? { allowExternalLinks } : {}),
      ...(ignoreCache !== undefined ? { ignoreCache } : {}),
      ...(sitemap !== undefined ? { sitemap } : {}),
      ...(useIndex !== undefined ? { useIndex } : {}),
      ...(maxSearchResults !== undefined ? { maxSearchResults } : {}),
      ...(abort !== undefined ? { abort } : {}),
      documents,
      ...(state !== undefined ? { state } : {}),
      ...(logger !== undefined ? { logger } : {}),
    });
    candidateDocs = collectedUrls.map(collectedUrl => {
      const existing = documents.get(collectedUrl);
      if (existing) {
        return existing;
      }
      if (scope) {
        try {
          const normalized = checkAndUpdateURLForMap(
            collectedUrl,
            scope.ignoreQueryParameters ?? true,
          ).url.trim();
          const normalizedExisting = documents.get(normalized);
          if (normalizedExisting) {
            return normalizedExisting;
          }
        } catch {
          // Invalid URL is dropped when applyMapScope runs below.
        }
      }
      return { url: collectedUrl };
    });
  }

  const skipScope = state?.skipScope === true;
  let finalDocs =
    scope && !skipScope
      ? applyMapScope(candidateDocs, url, scope)
      : dedupeMapDocumentArray(candidateDocs);
  if (search && state?.skipCosine !== true) {
    finalDocs = performCosineSimilarityV2(finalDocs, search.toLowerCase());
  }
  const sliced = finalDocs.slice(0, limit);
  return await applyMapFilterHook(sliced, {
    ctx,
    url,
    limit,
    state,
    logger,
  });
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
  maxFireEngineResults = MAX_SEARCH_RESULTS,
  id: providedId,
  zeroDataRetention: requestZeroDataRetention = false,
  ctx,
  startPageDiscovery = false,
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
  startPageDiscovery?: boolean | Record<string, unknown>;
}): Promise<MapResult> {
  const functionStartTime = Date.now();
  const startUrl = url;
  const discoverStartPage = Boolean(startPageDiscovery);

  const indexOnly = ctx?.lockdown === true;

  const resolvedUrl = indexOnly
    ? url
    : await resolveRedirects(url, abort, mock);

  // If the resolved URL is on a different registrable domain, replace the hostname
  if (
    !isSameMapSite(url, resolvedUrl) &&
    extractBaseDomain(url) &&
    extractBaseDomain(resolvedUrl)
  ) {
    const urlObj = new URL(url);
    urlObj.hostname = new URL(resolvedUrl).hostname;

    url = urlObj.toString();
  }

  const id = providedId ?? uuidv7();
  let mapResults: MapDocument[] = [];
  let discovery: MapDiscoveryInfo | undefined;
  const zeroDataRetention =
    ctx?.zeroDataRetention === true || requestZeroDataRetention || indexOnly;

  const mapCtx: RequestContext = ctx
    ? { ...ctx, zeroDataRetention }
    : requestContext({
        teamId,
        zeroDataRetention,
        flags: flags ?? undefined,
        orgId: orgId ?? null,
      });

  const sc: StoredCrawl = {
    ctx: mapCtx,
    originUrl: url,
    crawlerOptions: {
      ...crawlerOptions,
      limit: crawlerOptions.sitemapOnly ? 10000000 : limit,
      scrapeOptions: undefined,
    },
    scrapeOptions: scrapeOptions.parse({
      ...(location ? { location } : {}),
      headers: discoverStartPage ? withDefaultMapUserAgent(headers) : headers,
    }),
    internalOptions: { ctx: mapCtx, teamId, orgId: orgId ?? null },
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

  const scope: MapScopeOptions = {
    ignoreQueryParameters: crawlerOptions.ignoreQueryParameters ?? true,
    includeSubdomains,
    filterByPath,
    allowExternalLinks,
  };

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
  } else if (crawlerOptions.sitemap === "include" && !indexOnly) {
    const remainingBeforeSitemap =
      (crawlerOptions.timeout ?? 30_000) - (Date.now() - functionStartTime);
    const reserveForStartPage =
      discoverStartPage && !search
        ? Math.min(
            6_500,
            Math.floor(Math.max(0, remainingBeforeSitemap) * 0.45),
          )
        : 0;
    const sitemapTimeout =
      discoverStartPage && !search
        ? Math.max(
            1_000,
            Math.min(
              MAX_SITEMAP_BUDGET_MS,
              remainingBeforeSitemap - reserveForStartPage,
            ),
          )
        : Math.max(1_000, remainingBeforeSitemap);
    const sitemapCutoff = new AbortController();
    const sitemapSignal = AbortSignal.any([abort, sitemapCutoff.signal]);
    let acceptingSitemapUrls = true;
    const scopedSitemapUrls = new Set<string>();
    try {
      await crawler.tryGetSitemap(
        urls => {
          if (!acceptingSitemapUrls) return;
          const batch = urls.map(x => ({ url: x }));
          mapResults.push(...batch);
          if (discoverStartPage && !search && !sitemapCutoff.signal.aborted) {
            for (const doc of applyMapScope(batch, url, scope)) {
              scopedSitemapUrls.add(doc.url);
            }
            if (scopedSitemapUrls.size >= limit) {
              sitemapCutoff.abort();
            }
          }
        },
        true,
        false,
        sitemapTimeout,
        sitemapSignal,
        undefined,
        ignoreCache ? 0 : undefined,
      );
    } catch (e) {
      // Silently handle sitemap errors
    } finally {
      acceptingSitemapUrls = false;
    }
  }

  mapResults = applyMapScope(mapResults, url, scope);
  let effectiveScopeUrl = url;

  const hooks = installedService()?.hooks;
  const discoveryBudget = Math.min(
    START_PAGE_BUDGET_MS,
    (crawlerOptions.timeout ?? 30_000) - (Date.now() - functionStartTime) - 250,
  );
  if (
    discoverStartPage &&
    !hooks?.has("map.collect") &&
    crawlerOptions.sitemap === "include" &&
    !search &&
    !indexOnly &&
    !abort.aborted
  ) {
    const seedKeys = new Set(
      [startUrl, resolvedUrl, url].map(seed =>
        startPageLinkKey(
          checkAndUpdateURLForMap(
            seed,
            crawlerOptions.ignoreQueryParameters ?? true,
          ).url,
        ),
      ),
    );
    const hasNonSeedLinks = () =>
      mapResults.some(link => {
        const parsed = URL.parse(link.url);
        return Boolean(
          parsed &&
            !isMapUtilityPath(parsed.pathname) &&
            !seedKeys.has(startPageLinkKey(link.url)),
        );
      });

    if (mapResults.length >= limit || discoveryBudget < 1_000) {
      discovery = {
        outcome: hasNonSeedLinks() ? "links_found" : "timeout",
      };
    } else {
      const deadline = Date.now() + Math.ceil(discoveryBudget);
      const signal = AbortSignal.any([
        abort,
        AbortSignal.timeout(Math.ceil(discoveryBudget)),
      ]);
      const internalOptions: InternalOptions = {
        ctx: mapCtx,
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
      const startBaseDomain = extractBaseDomain(startUrl);
      const startPathname = new URL(startUrl).pathname.replace(/\/+$/, "");
      const options = {
        ...sc.scrapeOptions,
        // A Map request's caller headers belong to the origin the caller supplied.
        headers:
          new URL(resolvedUrl).origin === startOrigin ? headers : undefined,
        ...(crawlerOptions.useMock ? { useMock: crawlerOptions.useMock } : {}),
      };

      try {
        const robotsByOrigin = new Map<
          string,
          Promise<ReturnType<typeof crawlToCrawler>>
        >();
        if (sc.robots !== undefined) {
          robotsByOrigin.set(new URL(url).origin, Promise.resolve(crawler));
        }
        type RobotsDecision =
          | "allowed"
          | "disallowed"
          | "aborted"
          | "cap_exceeded";
        const checkRobots = async (target: string): Promise<RobotsDecision> => {
          if (signal.aborted) return "aborted";
          const origin = new URL(target).origin;
          let rules = robotsByOrigin.get(origin);
          if (!rules) {
            if (robotsByOrigin.size >= MAX_MAP_ROBOTS_ORIGINS) {
              return "cap_exceeded";
            }
            const originCrawler = crawlToCrawler(
              id,
              {
                ...sc,
                originUrl: origin,
                robots: undefined,
                scrapeOptions: {
                  ...sc.scrapeOptions,
                  headers: undefined,
                },
              },
              flags,
            );
            rules = originCrawler
              .getRobotsTxt(false, signal)
              .then(content => {
                originCrawler.importRobotsTxt(content);
                return originCrawler;
              })
              .catch(err => {
                if (signal.aborted) throw err;
                return originCrawler;
              });
            robotsByOrigin.set(origin, rules);
          }
          try {
            const originCrawler = await rules;
            if (signal.aborted) return "aborted";
            return originCrawler.isRobotsAllowed(target)
              ? "allowed"
              : "disallowed";
          } catch {
            return "aborted";
          }
        };

        const resolveScopeForPage = (pageUrl: string): string | null => {
          if (startBaseDomain) {
            const pageBaseDomain = extractBaseDomain(pageUrl);
            if (!pageBaseDomain) return null;
            if (pageBaseDomain === extractBaseDomain(url)) return url;
            const landedObj = new URL(pageUrl);
            if (!startPathname) {
              return landedObj.origin;
            }
            const scopedObj = new URL(url);
            scopedObj.protocol = landedObj.protocol;
            scopedObj.hostname = landedObj.hostname;
            scopedObj.port = landedObj.port;
            return scopedObj.toString();
          }
          return URL.parse(pageUrl)?.origin === startOrigin ? url : null;
        };

        const existingKeys = new Set(
          mapResults.map(link => startPageLinkKey(link.url)),
        );
        let robotsDeniedLanding = false;
        let robotsTimedOut = false;
        let acceptedScopeUrl = url;

        const additionalLinks = async (page: {
          url: string;
          links: string[];
        }): Promise<MapDocument[] | null> => {
          const scopeUrl = resolveScopeForPage(page.url);
          if (!scopeUrl) return null;
          const pageRobots = await checkRobots(page.url);
          if (pageRobots === "disallowed") {
            robotsDeniedLanding = true;
            return null;
          }
          if (pageRobots !== "allowed") {
            if (pageRobots === "aborted") robotsTimedOut = true;
            return null;
          }
          acceptedScopeUrl = scopeUrl;
          const pageKey = startPageLinkKey(
            checkAndUpdateURLForMap(
              page.url,
              crawlerOptions.ignoreQueryParameters ?? true,
            ).url,
          );
          const candidates = page.links.flatMap(link => {
            const target = URL.parse(link);
            if (
              !target ||
              !["http:", "https:"].includes(target.protocol) ||
              target.username ||
              target.password ||
              isMapUtilityPath(target.pathname) ||
              !isSameMapSite(target.href, scopeUrl) ||
              crawler.isFile(target.pathname)
            ) {
              return [];
            }
            target.hash = "";
            return [{ url: target.href }];
          });
          const seen = new Set([...seedKeys, pageKey, ...existingKeys]);
          const extra: MapDocument[] = [];
          for (const link of applyMapScope(candidates, scopeUrl, scope)) {
            const key = startPageLinkKey(link.url);
            if (seen.has(key)) continue;
            seen.add(key);
            if ((await checkRobots(link.url)) === "allowed") extra.push(link);
            if (signal.aborted || mapResults.length + extra.length >= limit)
              break;
          }
          return extra;
        };

        const isFilePath = (pathname: string) => crawler.isFile(pathname);
        const resolvedScopeOk = resolveScopeForPage(resolvedUrl) !== null;
        const [startRobots, resolvedRobots] = await Promise.all([
          checkRobots(startUrl),
          resolvedScopeOk
            ? checkRobots(resolvedUrl)
            : Promise.resolve("cap_exceeded" as const),
        ]);

        if (startRobots === "aborted" || resolvedRobots === "aborted") {
          discovery = {
            outcome: hasNonSeedLinks() ? "links_found" : "timeout",
          };
        } else if (
          startRobots === "disallowed" ||
          resolvedRobots === "disallowed"
        ) {
          discovery = {
            outcome: hasNonSeedLinks() ? "links_found" : "robots_disallowed",
          };
        } else if (!resolvedScopeOk || resolvedRobots !== "allowed") {
          discovery = {
            outcome: hasNonSeedLinks() ? "links_found" : "blocked_or_challenge",
          };
        } else {
          const step1 = await scrapeMapStartPage(
            resolvedUrl,
            options,
            internalOptions,
            deadline,
            0,
            isFilePath,
          );
          let extra =
            step1.kind === "html" ? await additionalLinks(step1) : null;
          let rendered: StartPageAttempt | null = null;

          const shouldRetryWithBrowser =
            !hasNonSeedLinks() &&
            !robotsDeniedLanding &&
            !robotsTimedOut &&
            (step1.kind === "html"
              ? extra !== null && extra.length === 0
              : step1.reason === "blocked_status" ||
                step1.reason === "http_error" ||
                step1.reason === "transport_error");

          if (shouldRetryWithBrowser) {
            rendered = await scrapeMapStartPage(
              resolvedUrl,
              options,
              internalOptions,
              deadline,
              START_PAGE_BROWSER_WAIT_MS,
              isFilePath,
            );
            if (rendered.kind === "html") {
              const renderedExtra = await additionalLinks(rendered);
              if (renderedExtra !== null) {
                extra = renderedExtra;
              }
            }
          }

          if (extra && extra.length > 0) {
            if (!hasNonSeedLinks() && !isSameMapSite(acceptedScopeUrl, url)) {
              effectiveScopeUrl = acceptedScopeUrl;
            }
            mapResults = mapResults.concat(extra).slice(0, limit);
          }

          const finalAttempt =
            rendered &&
            !(rendered.kind === "failed" && rendered.reason === "permit_busy")
              ? rendered
              : step1;
          if (hasNonSeedLinks()) {
            discovery = {
              outcome: "links_found",
              statusCode: finalAttempt.statusCode,
              landedUrl: finalAttempt.url,
            };
          } else if (robotsDeniedLanding) {
            discovery = { outcome: "robots_disallowed" };
          } else if (robotsTimedOut) {
            discovery = { outcome: "timeout" };
          } else if (rendered?.kind === "html") {
            const normalizedLanded = checkAndUpdateURLForMap(
              rendered.url,
              crawlerOptions.ignoreQueryParameters ?? true,
            ).url;
            const isSubpathScoped = Boolean(
              filterByPath && !allowExternalLinks && startPathname,
            );
            discovery = {
              outcome:
                !isSubpathScoped &&
                isVerifiedCleanSinglePage(rendered.rawHtml, rendered.title)
                  ? "verified_single_page"
                  : "blocked_or_challenge",
              statusCode: rendered.statusCode,
              landedUrl: normalizedLanded,
            };
          } else {
            const failure =
              finalAttempt.kind === "failed" ? finalAttempt : null;
            const reason = failure?.reason;
            discovery = {
              outcome:
                reason === "dns_error"
                  ? "dns_error"
                  : reason === "http_not_found"
                    ? "http_not_found"
                    : reason === "ssl_error"
                      ? "ssl_error"
                      : reason === "unsupported_file"
                        ? "unsupported_file"
                        : reason === "timeout"
                          ? "timeout"
                          : reason === "http_error"
                            ? "http_error"
                            : "blocked_or_challenge",
              statusCode: finalAttempt.statusCode,
              landedUrl: finalAttempt.url,
            };
          }
        }
      } catch {
        // Optional discovery must not discard sitemap results.
        discovery = {
          outcome: hasNonSeedLinks() ? "links_found" : "timeout",
        };
      }
    }
  }

  const mapState: Record<string, unknown> = {};
  if (hooks?.has("map.collect")) {
    mapResults = await applyMapCollectHook(mapResults, {
      ctx: mapCtx,
      url: effectiveScopeUrl,
      limit,
      scope,
      search,
      includeSubdomains,
      allowExternalLinks,
      ignoreCache,
      sitemap: crawlerOptions.sitemap,
      useIndex,
      maxSearchResults: maxFireEngineResults,
      abort,
      state: mapState,
    });
  } else {
    if (search) {
      mapResults = performCosineSimilarityV2(mapResults, search.toLowerCase());
    }
    mapResults = mapResults.slice(0, limit);
    if (hooks?.has("map.filter")) {
      mapResults = await applyMapFilterHook(mapResults, {
        ctx: mapCtx,
        url: effectiveScopeUrl,
        limit,
        state: mapState,
      });
    }
  }

  const totalTimeMs = Date.now() - functionStartTime;

  return {
    success: true,
    mapResults,
    job_id: id,
    time_taken: totalTimeMs,
    state: mapState,
    ...(discovery ? { discovery } : {}),
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
