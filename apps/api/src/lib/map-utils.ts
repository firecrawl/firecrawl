import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type {
  TeamFlags,
  MapDocument,
  ScrapeOptions,
} from "../controllers/v2/types";
import { scrapeOptions, MAX_MAP_LIMIT } from "../controllers/v2/types";
import type { StoredCrawl, StoredCrawlerOptions } from "./crawl-redis";
import { crawlToCrawler } from "./crawl-redis";
import {
  checkAndUpdateURLForMap,
  isSameDomain,
  isSameSubdomain,
  resolveRedirects,
} from "./validateUrl";
import { performCosineSimilarityV2 } from "./map-cosine";
import type { Logger } from "winston";
import { requestContext } from "./request-context";
import type { HookPoints, MapState } from "../service/hooks";
import type { RequestContext } from "../service/request-context";
import { installedService } from "../service/service";

const errorWithMessageSchema = z.object({
  message: z.unknown(),
});

const MAX_SEARCH_RESULTS = 100;

export interface MapResult {
  success: boolean;
  job_id: string;
  time_taken: number;
  mapResults: Array<MapDocument>;
  state?: MapState;
}

function dedupeMapDocumentArray(
  documents: Array<MapDocument>,
): Array<MapDocument> {
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

interface MapScopeOptions {
  ignoreQueryParameters?: boolean;
  includeSubdomains?: boolean;
  filterByPath?: boolean;
  allowExternalLinks?: boolean;
}

interface MapScrapeOptionsInput {
  location?: ScrapeOptions["location"];
  headers?: Record<string, string>;
}

function applyMapScope(
  documents: Array<MapDocument>,
  baseUrl: string,
  {
    ignoreQueryParameters = true,
    includeSubdomains = true,
    filterByPath = true,
    allowExternalLinks = false,
  }: MapScopeOptions = {},
): Array<MapDocument> {
  let scoped: Array<MapDocument> = [];
  for (const x of documents) {
    try {
      scoped.push({
        ...x,
        url: checkAndUpdateURLForMap(x.url, ignoreQueryParameters).url.trim(),
      });
    } catch {
      // Drop malformed URLs.
    }
  }

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
 * Applies registered `map.filter` hooks to scoped, sorted, and limit-sliced
 * map documents.
 */
export async function applyMapFilterHook(
  mapResults: Array<MapDocument>,
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
    state?: MapState;
    logger?: Logger;
  },
): Promise<Array<MapDocument>> {
  const hooks = installedService()?.hooks;
  if (!hooks?.has("map.filter")) {
    return mapResults;
  }
  const meta: HookPoints["map.filter"]["info"] = { ctx, url, limit };
  if (state !== undefined) {
    meta.state = state;
  }
  if (logger !== undefined) {
    meta.logger = logger;
  }
  return await hooks.transform("map.filter", mapResults, meta);
}

/**
 * Applies registered `map.collect` hooks to candidate map documents,
 * preserving existing metadata, reapplying map scope when provided,
 * deduplicating, slicing to `limit`, and applying registered `map.filter`
 * hooks post-scope and post-limit.
 */
export async function applyMapCollectHook(
  mapResults: Array<MapDocument>,
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
    state?: MapState;
    logger?: Logger;
  },
): Promise<Array<MapDocument>> {
  const hooks = installedService()?.hooks;
  const skipDiscovery = state?.skipDiscovery === true;
  const runCollect = Boolean(hooks?.has("map.collect")) && !skipDiscovery;
  if (!runCollect && !hooks?.has("map.filter") && !skipDiscovery) {
    return mapResults;
  }

  let candidateDocs = mapResults;
  if (runCollect && hooks) {
    const deduped = dedupeMapDocumentArray(mapResults);
    const currentUrls = deduped.map(doc => doc.url);
    const documents = new Map<string, MapDocument>();
    for (const doc of deduped) {
      documents.set(doc.url, doc);
    }
    const collectMeta: HookPoints["map.collect"]["info"] = {
      ctx,
      url,
      limit,
      documents,
    };
    if (search !== undefined) {
      collectMeta.search = search;
    }
    if (includeSubdomains !== undefined) {
      collectMeta.includeSubdomains = includeSubdomains;
    }
    if (allowExternalLinks !== undefined) {
      collectMeta.allowExternalLinks = allowExternalLinks;
    }
    if (ignoreCache !== undefined) {
      collectMeta.ignoreCache = ignoreCache;
    }
    if (sitemap !== undefined) {
      collectMeta.sitemap = sitemap;
    }
    if (useIndex !== undefined) {
      collectMeta.useIndex = useIndex;
    }
    if (maxSearchResults !== undefined) {
      collectMeta.maxSearchResults = maxSearchResults;
    }
    if (abort !== undefined) {
      collectMeta.abort = abort;
    }
    if (state !== undefined) {
      collectMeta.state = state;
    }
    if (logger !== undefined) {
      collectMeta.logger = logger;
    }
    const collectedUrls = await hooks.transform(
      "map.collect",
      currentUrls,
      collectMeta,
    );
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
}: {
  url: string;
  search?: string;
  limit?: number;
  includeSubdomains?: boolean;
  crawlerOptions?: StoredCrawlerOptions;
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
}): Promise<MapResult> {
  const functionStartTime = Date.now();

  const indexOnly = ctx?.lockdown === true;

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
  let mapResults: Array<MapDocument> = [];
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

  const rawScrapeOptions: MapScrapeOptionsInput = {};
  if (location) {
    rawScrapeOptions.location = location;
  }
  if (headers) {
    rawScrapeOptions.headers = headers;
  }

  const sc: StoredCrawl = {
    ctx: mapCtx,
    originUrl: url,
    crawlerOptions: {
      ...crawlerOptions,
      limit: crawlerOptions.sitemapOnly ? 10_000_000 : limit,
      scrapeOptions: undefined,
    },
    scrapeOptions: scrapeOptions.parse(rawScrapeOptions),
    internalOptions: { ctx: mapCtx, teamId, orgId: orgId ?? null },
    team_id: teamId,
    createdAt: Date.now(),
    zeroDataRetention,
  };

  const crawler = crawlToCrawler(id, sc, flags);

  try {
    sc.robots = await crawler.getRobotsTxt(false, abort);
    crawler.importRobotsTxt(sc.robots);
  } catch {
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
      crawlerOptions.timeout ?? 30_000,
      abort,
      crawlerOptions.useMock,
      ignoreCache ? 0 : undefined,
    );

    if (sitemap > 0) {
      const normalizedResults: Array<MapDocument> = [];
      for (const x of mapResults) {
        try {
          normalizedResults.push({
            ...x,
            url: checkAndUpdateURLForMap(x.url).url.trim(),
          });
        } catch {
          // Drop malformed URLs.
        }
      }
      mapResults = normalizedResults;
    }
  } else if (crawlerOptions.sitemap === "include" && !indexOnly) {
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
        crawlerOptions.timeout ?? 30_000,
        abort,
        undefined,
        ignoreCache ? 0 : undefined,
      );
    } catch {
      // Silently handle sitemap errors
    }
  }

  const scope: MapScopeOptions = {
    ignoreQueryParameters: crawlerOptions.ignoreQueryParameters ?? true,
    includeSubdomains,
    filterByPath,
    allowExternalLinks,
  };
  mapResults = applyMapScope(mapResults, url, scope);

  const mapState: MapState = {};
  const hooks = installedService()?.hooks;
  if (hooks?.has("map.collect")) {
    mapResults = await applyMapCollectHook(mapResults, {
      ctx: mapCtx,
      url,
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
        url,
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
}): Promise<{ prompt: string; websiteUrls: Array<string> }> {
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
  } catch (error: unknown) {
    const parsedError = errorWithMessageSchema.safeParse(error);
    const message =
      error instanceof Error
        ? error.message
        : parsedError.success
          ? (parsedError.data.message ?? error)
          : error;
    logger.warn("Failed to get website structure for prompt enhancement", {
      error: message,
    });
    return { prompt: basePrompt, websiteUrls: [] };
  }
}
