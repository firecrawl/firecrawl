import type { Logger } from "winston";
import { search } from "./v2";
import type {
  SearchV2Response,
  SearchResultType,
  WebSearchResult,
  SearchResultCountsBySource,
  SearchResultCategoriesBySource,
} from "../lib/entities";
import {
  countSearchResultsBySource,
  collectSearchResultCategories,
} from "../lib/entities";
import type { CategoryOption } from "../lib/search-query-builder";
import {
  buildSearchQuery,
  getCategoryFromUrl,
} from "../lib/search-query-builder";
import type {
  Document,
  ScrapeOptions,
  TeamFlags,
} from "../controllers/v2/types";
import {
  getItemsToScrape,
  scrapeSearchResults,
  mergeScrapedContent,
} from "./scrape";
import {
  matchesQueryOperators,
  planOperatorQuery,
  siteHostnames,
} from "./operators";
import type { BillingMetadata } from "../lib/billing-types";
import type { TeamPlanClass } from "../service/search-providers";
import { requestContext } from "../lib/request-context";
import type { SearchHit, SearchState } from "../service/hooks";
import type { SearchRequest } from "../service/request";
import type { RequestContext } from "../service/request-context";
import { installedService } from "../service/service";
import { applySearchPlanHook } from "./plan-hook";

interface SearchOptions {
  query: string;
  limit: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  sources: Array<{ type: string }>;
  categories?: Array<CategoryOption | { type: string; sites?: Array<string> }>;
  includeDomains?: Array<string>;
  excludeDomains?: Array<string>;
  enterprise?: Array<"default" | "anon" | "zdr">;
  scrapeOptions?: ScrapeOptions;
  highlights?: boolean;
  domainTools?: boolean;
  toolDetail?: "compact" | "summary" | "full";
  inferToolQuery?: boolean;
  autoTools?: boolean;
  toolFusion?: boolean;
  timeout: number;
}

interface SearchContext {
  teamId: string;
  orgId?: string | null;
  origin: string;
  integration?: string | null;
  clientOrigin?: string;
  clientSession?: string;
  clientThread?: string;
  apiKeyId: number | null;
  flags: TeamFlags;
  concurrencyLimit?: number;
  rateLimitMultiplier?: number;
  teamPlanClass: TeamPlanClass | undefined;
  requestId: string;
  jobId: string;
  apiVersion: string;
  bypassBilling?: boolean;
  zeroDataRetention?: boolean;
  billing?: BillingMetadata;
  agentIndexOnly?: boolean;
  keylessReserved?: boolean;
  threatProtectionPolicy?: unknown;
  safeModeBypassed?: boolean;
  workContactOnly?: boolean;
  ctx?: RequestContext;
  body?: SearchRequest;
  planApplied?: boolean;
  state?: SearchState;
}

interface SearchExecuteResult {
  usOnlyWarning?: string;
  toolsWarning?: string;
  toolsAuto?: boolean;
  toolsUnavailable?: boolean;
  toolFusion: boolean;
  skillsDiscovered?: boolean;
  response: SearchV2Response;
  totalResultsCount: number;
  billableResultsCount: number;
  resultCountsBySource: SearchResultCountsBySource;
  resultCategories: SearchResultCategoriesBySource;
  indexResultsCount: number;
  threatDecisions: Array<unknown>;
  scrapedDocuments: Array<Document>;
  searchTypes: Array<SearchResultType>;
  scrapeFormats: Array<string>;
  shouldScrape: boolean;
}

type SearchRequestFallback = SearchRequest & {
  enterprise?: SearchOptions["enterprise"];
  highlights?: SearchOptions["highlights"];
  domainTools?: SearchOptions["domainTools"];
  toolDetail?: SearchOptions["toolDetail"];
};

function isCoreSearchSource(type: string): type is SearchResultType {
  return type === "web" || type === "images" || type === "news";
}

function nonEmpty(list: Array<string>): Array<string> | undefined {
  return list.length > 0 ? list : undefined;
}

function buildSearchRequestFallback(
  options: SearchOptions,
  context: SearchContext,
): SearchRequest {
  const fallbackCategories: NonNullable<SearchRequest["categories"]> = (
    options.categories ?? []
  ).map(category =>
    typeof category === "string" ? { type: category } : category,
  );
  const fallback: SearchRequestFallback = {
    query: options.query,
    limit: options.limit,
    tbs: options.tbs,
    filter: options.filter,
    sources: options.sources,
    categories: fallbackCategories,
    includeDomains: options.includeDomains,
    excludeDomains: options.excludeDomains,
    lang: options.lang ?? "en",
    safe: options.safe,
    enterprise: options.enterprise,
    country: options.country,
    location: options.location,
    origin: context.origin ?? "api",
    integration: context.integration ?? null,
    timeout: options.timeout,
    ignoreInvalidURLs: false,
    asyncScraping: false,
    highlights: options.highlights,
    domainTools: options.domainTools,
    toolDetail: options.toolDetail ?? "compact",
    scrapeOptions: options.scrapeOptions,
  };
  return fallback;
}

export async function executeSearch(
  options: SearchOptions,
  context: SearchContext,
  logger: Logger,
): Promise<SearchExecuteResult> {
  let { query, limit, sources } = options;
  const { categories, scrapeOptions } = options;
  const {
    teamId,
    orgId,
    origin,
    apiKeyId,
    flags,
    requestId,
    bypassBilling,
    zeroDataRetention,
    billing,
  } = context;

  const hooks = installedService()?.hooks;
  const shouldRunPlan =
    !context.planApplied && Boolean(hooks?.has("search.plan"));
  const hasResultsHook = Boolean(hooks?.has("search.results"));
  const hookContext =
    shouldRunPlan || hasResultsHook
      ? {
          ctx:
            context.ctx ??
            requestContext({
              teamId,
              zeroDataRetention,
              flags: flags ?? undefined,
              orgId: orgId ?? null,
              apiKeyId,
              billing,
            }),
          body: context.body ?? buildSearchRequestFallback(options, context),
        }
      : undefined;

  const searchState: SearchState = context.state ?? {};

  if (shouldRunPlan && hookContext) {
    const planned = await applySearchPlanHook(
      { query, limit, sources },
      {
        ctx: hookContext.ctx,
        body: hookContext.body,
        state: searchState,
        logger,
      },
    );
    query = planned.query;
    limit = planned.limit;
    sources = planned.sources;
  }

  const num_results_buffer = Math.floor(limit * 2);
  const usOnly = context.ctx?.usOnly === true || flags?.usOnly === true;

  logger.info("Searching for results");

  const searchTypes: Array<SearchResultType> = [];
  const seenSearchTypes = new Set<SearchResultType>();
  for (const source of sources) {
    if (isCoreSearchSource(source.type) && !seenSearchTypes.has(source.type)) {
      seenSearchTypes.add(source.type);
      searchTypes.push(source.type);
    }
  }
  const operatorPlan = planOperatorQuery(query);
  const { operators } = operatorPlan;
  const queryCategories: Array<CategoryOption> | undefined =
    categories?.flatMap((category): Array<CategoryOption> => {
      if (typeof category === "string") {
        return [category];
      }
      switch (category.type) {
        case "research":
        case "pdf":
        case "developer":
        case "gov":
          return [{ type: category.type, sites: category.sites }];
        default:
          return [];
      }
    });
  const { query: searchQuery, categoryMap } = buildSearchQuery(
    operatorPlan.query,
    queryCategories,
    {
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
    },
  );

  const webSearchPromise =
    searchTypes.length === 0
      ? null
      : search({
          query: searchQuery,
          logger,
          requestId: context.requestId,
          advanced: false,
          num_results: operatorPlan.relaxed
            ? Math.max(num_results_buffer, Math.min(limit * 5, 100))
            : num_results_buffer,
          tbs: options.tbs,
          filter: options.filter,
          lang: options.lang,
          country: options.country,
          location: options.location,
          safe: options.safe,
          type: searchTypes,
          enterprise: options.enterprise,
          includeDomains: options.includeDomains?.length
            ? options.includeDomains
            : nonEmpty(siteHostnames(operators.sites)),
          excludeDomains: nonEmpty([
            ...(options.excludeDomains ?? []),
            ...operators.excludedSites.filter(site => !site.includes("/")),
          ]),
          usOnly,
          teamPlanClass: context.teamPlanClass,
        });

  const searchResponse: SearchV2Response =
    webSearchPromise === null ? {} : await webSearchPromise;

  if (Array.isArray(searchState.routedResults)) {
    const routedWeb = searchState.routedResults;
    searchResponse.web = (
      searchResponse.web
        ? [...routedWeb, ...searchResponse.web]
        : [...routedWeb]
    ).map((result, index) => ({ ...result, position: index + 1 }));
  }

  const keepOperatorMatches = <
    T extends { url?: string; title?: string; position?: number },
  >(
    results: Array<T> | undefined,
  ): Array<T> | undefined => {
    const kept = results?.filter(result =>
      matchesQueryOperators(result, operatorPlan),
    );
    return kept?.length === results?.length
      ? results
      : kept?.map((result, index) => ({ ...result, position: index + 1 }));
  };
  searchResponse.web = keepOperatorMatches(searchResponse.web);
  searchResponse.news = keepOperatorMatches(searchResponse.news);
  searchResponse.images = keepOperatorMatches(searchResponse.images);

  if (hooks?.has("search.results") && hookContext) {
    type NewsItem = NonNullable<SearchV2Response["news"]>[number];
    type ImageItem = NonNullable<SearchV2Response["images"]>[number];
    type ResultEntry =
      | { group: "web"; item: WebSearchResult }
      | { group: "news"; item: NewsItem }
      | { group: "images"; item: ImageItem };

    const hits: Array<SearchHit> = [];
    const byRef = new Map<SearchHit, ResultEntry>();
    const byUrl = new Map<string, Array<ResultEntry>>();
    const newsWithoutUrl: Array<{ index: number; item: NewsItem }> = [];
    const imagesWithoutUrl: Array<{ index: number; item: ImageItem }> = [];

    const record = (hit: SearchHit, entry: ResultEntry) => {
      hits.push(hit);
      byRef.set(hit, entry);
      const bucket = byUrl.get(hit.url);
      if (bucket) {
        bucket.push(entry);
      } else {
        byUrl.set(hit.url, [entry]);
      }
    };

    const hadWeb = searchResponse.web !== undefined;
    const hadNews = searchResponse.news !== undefined;
    const hadImages = searchResponse.images !== undefined;

    if (searchResponse.web) {
      for (const item of searchResponse.web) {
        const hit: SearchHit = {
          url: item.url,
          title: item.title,
          description: item.description,
          group: "web",
        };
        if (item.category !== undefined) {
          hit.category = item.category;
        }
        record(hit, { group: "web", item });
      }
    }

    if (searchResponse.news) {
      for (let i = 0; i < searchResponse.news.length; i++) {
        const item = searchResponse.news[i];
        if (!item.url) {
          newsWithoutUrl.push({ index: i, item });
          continue;
        }
        const hit: SearchHit = {
          url: item.url,
          title: item.title,
          description: item.snippet,
          group: "news",
        };
        if (item.category !== undefined) {
          hit.category = item.category;
        }
        if (item.imageUrl !== undefined) {
          hit.imageUrl = item.imageUrl;
        }
        record(hit, { group: "news", item });
      }
    }

    if (searchResponse.images) {
      for (let i = 0; i < searchResponse.images.length; i++) {
        const item = searchResponse.images[i];
        if (!item.url) {
          imagesWithoutUrl.push({ index: i, item });
          continue;
        }
        const hit: SearchHit = {
          url: item.url,
          title: item.title,
          group: "images",
        };
        if (item.imageUrl !== undefined) {
          hit.imageUrl = item.imageUrl;
        }
        if (item.imageWidth !== undefined) {
          hit.imageWidth = item.imageWidth;
        }
        if (item.imageHeight !== undefined) {
          hit.imageHeight = item.imageHeight;
        }
        record(hit, { group: "images", item });
      }
    }

    const transformed = await hooks.transform("search.results", hits, {
      ctx: hookContext.ctx,
      body: hookContext.body,
      state: searchState,
      response: searchResponse,
      logger,
    });

    const nextWeb: Array<WebSearchResult> = [];
    const nextNews: Array<NewsItem> = [];
    const nextImages: Array<ImageItem> = [];
    const consumed = new Set<ResultEntry>();

    for (const hit of transformed) {
      let entry = byRef.get(hit);
      if (entry && consumed.has(entry)) {
        entry = undefined;
      }
      if (!entry) {
        const candidates = byUrl.get(hit.url);
        if (candidates) {
          entry = hit.group
            ? candidates.find(
                candidate =>
                  !consumed.has(candidate) && candidate.group === hit.group,
              )
            : candidates.find(candidate => !consumed.has(candidate));
        }
      }
      if (entry) {
        consumed.add(entry);
        if (entry.group === "web") {
          const merged: WebSearchResult = {
            ...entry.item,
            url: hit.url,
            title: hit.title ?? entry.item.title,
            description: hit.description ?? entry.item.description,
          };
          if (hit.category !== undefined) {
            merged.category = hit.category;
          }
          nextWeb.push(merged);
        } else if (entry.group === "news") {
          const merged: NewsItem = {
            ...entry.item,
            url: hit.url,
            title: hit.title ?? entry.item.title,
            snippet: hit.description ?? entry.item.snippet,
          };
          if (hit.category !== undefined) {
            merged.category = hit.category;
          }
          if (hit.imageUrl !== undefined) {
            merged.imageUrl = hit.imageUrl;
          }
          nextNews.push(merged);
        } else {
          const merged: ImageItem = {
            ...entry.item,
            url: hit.url,
            title: hit.title ?? entry.item.title,
          };
          if (hit.imageUrl !== undefined) {
            merged.imageUrl = hit.imageUrl;
          }
          if (hit.imageWidth !== undefined) {
            merged.imageWidth = hit.imageWidth;
          }
          if (hit.imageHeight !== undefined) {
            merged.imageHeight = hit.imageHeight;
          }
          nextImages.push(merged);
        }
      } else if (hit.group === "news") {
        const added: NewsItem = {
          url: hit.url,
          title: hit.title ?? "",
          snippet: hit.description ?? "",
        };
        if (hit.category !== undefined) {
          added.category = hit.category;
        }
        if (hit.imageUrl !== undefined) {
          added.imageUrl = hit.imageUrl;
        }
        nextNews.push(added);
      } else if (hit.group === "images") {
        const added: ImageItem = {
          url: hit.url,
          title: hit.title ?? "",
        };
        if (hit.imageUrl !== undefined) {
          added.imageUrl = hit.imageUrl;
        }
        if (hit.imageWidth !== undefined) {
          added.imageWidth = hit.imageWidth;
        }
        if (hit.imageHeight !== undefined) {
          added.imageHeight = hit.imageHeight;
        }
        nextImages.push(added);
      } else {
        const added: WebSearchResult = {
          url: hit.url,
          title: hit.title ?? "",
          description: hit.description ?? "",
        };
        if (hit.category !== undefined) {
          added.category = hit.category;
        }
        nextWeb.push(added);
      }
    }

    for (const { index, item } of newsWithoutUrl) {
      nextNews.splice(Math.min(index, nextNews.length), 0, item);
    }
    for (const { index, item } of imagesWithoutUrl) {
      nextImages.splice(Math.min(index, nextImages.length), 0, item);
    }

    if (hadWeb || nextWeb.length > 0) {
      searchResponse.web = nextWeb.map((item, index) => ({
        ...item,
        position: index + 1,
      }));
    }
    if (hadNews || nextNews.length > 0) {
      searchResponse.news = nextNews.map((item, index) => ({
        ...item,
        position: index + 1,
      }));
    }
    if (hadImages || nextImages.length > 0) {
      searchResponse.images = nextImages.map((item, index) => ({
        ...item,
        position: index + 1,
      }));
    }
  }

  const threatDecisions: Array<unknown> = Array.isArray(
    searchState.threatDecisions,
  )
    ? searchState.threatDecisions
    : [];

  if (searchResponse.web && searchResponse.web.length > 0) {
    searchResponse.web = searchResponse.web.map(result => ({
      ...result,
      category: result.category ?? getCategoryFromUrl(result.url, categoryMap),
    }));
  }

  if (searchResponse.news && searchResponse.news.length > 0) {
    searchResponse.news = searchResponse.news.map(result => ({
      ...result,
      category:
        result.category ??
        (result.url ? getCategoryFromUrl(result.url, categoryMap) : undefined),
    }));
  }

  let totalResultsCount = 0;

  if (searchResponse.web && searchResponse.web.length > 0) {
    if (searchResponse.web.length > limit) {
      searchResponse.web = searchResponse.web.slice(0, limit);
    }
    totalResultsCount += searchResponse.web.length;
  }

  if (searchResponse.images && searchResponse.images.length > 0) {
    if (searchResponse.images.length > limit) {
      searchResponse.images = searchResponse.images.slice(0, limit);
    }
    totalResultsCount += searchResponse.images.length;
  }

  if (searchResponse.news && searchResponse.news.length > 0) {
    if (searchResponse.news.length > limit) {
      searchResponse.news = searchResponse.news.slice(0, limit);
    }
    totalResultsCount += searchResponse.news.length;
  }

  const nonBillableResultsCount =
    typeof searchState.nonBillableResultsCount === "number" &&
    Number.isFinite(searchState.nonBillableResultsCount) &&
    searchState.nonBillableResultsCount > 0
      ? Math.floor(searchState.nonBillableResultsCount)
      : 0;
  const billableResultsCount = Math.max(
    0,
    totalResultsCount - nonBillableResultsCount,
  );
  let scrapedDocuments: Array<Document> = [];

  const shouldScrape =
    scrapeOptions?.formats && scrapeOptions.formats.length > 0;

  if (shouldScrape && scrapeOptions) {
    const itemsToScrape = getItemsToScrape(searchResponse, flags, {
      team_id: teamId,
      org_id: orgId ?? null,
      origin,
      zeroDataRetention,
      ctx: context.ctx,
    });

    if (itemsToScrape.length > 0) {
      const scrapeOpts: Parameters<typeof scrapeSearchResults>[1] = {
        teamId,
        orgId: orgId ?? null,
        origin,
        timeout: options.timeout,
        scrapeOptions,
        bypassBilling: bypassBilling ?? false,
        apiKeyId,
        zeroDataRetention,
        requestId,
        billing,
        agentIndexOnly: context.agentIndexOnly,
        keylessReserved: context.keylessReserved,
        ctx: context.ctx,
      };
      if (context.workContactOnly) {
        scrapeOpts.workContactOnly = true;
      }
      if (context.concurrencyLimit !== undefined) {
        scrapeOpts.concurrencyLimit = context.concurrencyLimit;
      }
      if (context.rateLimitMultiplier !== undefined) {
        scrapeOpts.rateLimitMultiplier = context.rateLimitMultiplier;
      }

      const allDocsWithCostTracking = await scrapeSearchResults(
        itemsToScrape.map(i => i.scrapeInput),
        scrapeOpts,
        logger,
        flags,
      );

      mergeScrapedContent(
        searchResponse,
        itemsToScrape,
        allDocsWithCostTracking,
      );
      scrapedDocuments = allDocsWithCostTracking.map(item => item.document);
    }
  }

  const scrapeFormats = scrapeOptions?.formats
    ? scrapeOptions.formats.map(f => (typeof f === "string" ? f : f.type))
    : [];

  return {
    response: searchResponse,
    toolFusion: false,
    totalResultsCount,
    billableResultsCount,
    resultCountsBySource: countSearchResultsBySource(searchResponse),
    resultCategories: collectSearchResultCategories(searchResponse),
    indexResultsCount:
      typeof searchState.indexResultsCount === "number" &&
      Number.isFinite(searchState.indexResultsCount) &&
      searchState.indexResultsCount >= 0
        ? Math.floor(searchState.indexResultsCount)
        : 0,
    threatDecisions,
    scrapedDocuments,
    searchTypes,
    scrapeFormats,
    shouldScrape: shouldScrape ?? false,
  };
}
