import { config } from "../config";
import type { SearchV2Response, WebSearchResult } from "../lib/entities";
import {
  coreSearchProviderSpecs,
  type SearchProvider,
  type SearchProviderName,
  type SearchQuery,
} from "../service/search-providers";
import { fire_engine_search } from "./fireEngine";
import { matchesDomains } from "./operators";
import { searxng_search as searxng_search_legacy } from "./searxng";
import { ddgSearch } from "./v2/ddgsearch";
import { fire_engine_search_v2 } from "./v2/fireEngine-v2";
import { searxng_search as searxng_search_v2 } from "./v2/searxng";

function filterWebByDomains(
  results: SearchV2Response,
  query: SearchQuery,
): WebSearchResult[] {
  return (results.web ?? []).filter(result =>
    matchesDomains(result.url, query.includeDomains, query.excludeDomains),
  );
}

const providerImplementations: Record<
  SearchProviderName,
  Pick<SearchProvider, "enabled" | "search">
> = {
  "fire-engine": {
    enabled: () => Boolean(config.FIRE_ENGINE_BETA_URL),
    async search(query) {
      query.logger?.info("Using fire engine search");
      if (query.legacy) {
        const results = await fire_engine_search(
          query.query,
          {
            numResults: query.numResults,
            tbs: query.tbs,
            filter: query.filter,
            lang: query.lang,
            country: query.country,
            location: query.location,
            ...(query.page !== undefined ? { page: query.page } : {}),
            usOnly: query.usOnly,
          },
          query.abort,
        );
        return { web: results };
      }

      return fire_engine_search_v2(
        query.query,
        {
          requestId: query.requestId,
          numResults: query.numResults,
          tbs: query.tbs,
          filter: query.filter,
          lang: query.lang,
          country: query.country,
          location: query.location,
          safe: query.safe,
          ...(query.page !== undefined ? { page: query.page } : {}),
          type: query.type,
          enterprise: query.enterprise,
          includeDomains: query.includeDomains,
          excludeDomains: query.excludeDomains,
          usOnly: query.usOnly,
          teamPlanClass: query.teamPlanClass,
        },
        query.abort,
      );
    },
  },
  searxng: {
    enabled: () => Boolean(config.SEARXNG_ENDPOINT),
    async search(query) {
      query.logger?.info("Using searxng search");
      if (query.legacy) {
        const results = await searxng_search_legacy(query.query, {
          num_results: query.numResults,
          tbs: query.tbs,
          filter: query.filter,
          lang: query.lang,
          country: query.country,
          location: query.location,
          ...(query.page !== undefined ? { page: query.page } : {}),
        });
        return results.length > 0 ? { web: results } : null;
      }

      // SearXNG receives domain constraints only as site: operators in the
      // query, which it may not strictly enforce, so filter results here.
      const web = filterWebByDomains(
        await searxng_search_v2(query.query, {
          num_results: query.numResults,
          tbs: query.tbs,
          filter: query.filter,
          lang: query.lang,
          country: query.country,
          location: query.location,
          safe: query.safe,
          ...(query.page !== undefined ? { page: query.page } : {}),
        }),
        query,
      );
      return web.length > 0 ? { web } : null;
    },
  },
  duckduckgo: {
    enabled: () => true,
    async search(query) {
      query.logger?.info("Using DuckDuckGo search");
      const raw = await ddgSearch(query.query, query.numResults, {
        tbs: query.tbs,
        lang: query.lang,
        country: query.country,
        proxy: query.proxy,
        timeout: query.timeout,
      });
      if (query.legacy) {
        return raw.web && raw.web.length > 0 ? { web: raw.web } : null;
      }
      const web = filterWebByDomains(raw, query);
      return web.length > 0 ? { web } : null;
    },
  },
};

/** Built-in search providers registered by `coreParts()`. */
export const coreSearchProviders: readonly SearchProvider[] = Object.freeze(
  coreSearchProviderSpecs.map(spec => {
    const impl = providerImplementations[spec.name];
    return Object.freeze({
      name: spec.name,
      priority: spec.priority,
      ...(spec.supportsUsOnly ? { supportsUsOnly: true } : {}),
      enabled: impl.enabled,
      search: impl.search,
    });
  }),
);
