import { config } from "../config";
import type { SearchV2Response, WebSearchResult } from "../lib/entities";
import { coreSearchProviderSpecs } from "../service/search-providers";
import type {
  SearchProvider,
  SearchProviderName,
  SearchQuery,
} from "../service/search-providers";
import { matchesDomains } from "./operators";
import { searxng_search as searxng_search_legacy } from "./searxng";
import { ddgSearch } from "./v2/ddgsearch";
import { searxng_search as searxng_search_v2 } from "./v2/searxng";

function filterWebByDomains(
  results: SearchV2Response,
  query: SearchQuery,
): Array<WebSearchResult> {
  return (results.web ?? []).filter(result =>
    matchesDomains(result.url, query.includeDomains, query.excludeDomains),
  );
}

const providerImplementations: Record<
  SearchProviderName,
  Pick<SearchProvider, "enabled" | "search">
> = {
  searxng: {
    enabled: () => Boolean(config.SEARXNG_ENDPOINT),
    async search(query) {
      query.logger?.info("Using searxng search");
      if (query.legacy) {
        const legacyOptions: Parameters<typeof searxng_search_legacy>[1] = {
          num_results: query.numResults,
          tbs: query.tbs,
          filter: query.filter,
          lang: query.lang,
          country: query.country,
          location: query.location,
        };
        if (query.page !== undefined) {
          legacyOptions.page = query.page;
        }
        const results = await searxng_search_legacy(query.query, legacyOptions);
        return results.length > 0 ? { web: results } : null;
      }

      // SearXNG receives domain constraints only as site: operators in the
      // query, which it may not strictly enforce, so filter results here.
      const v2Options: Parameters<typeof searxng_search_v2>[1] = {
        num_results: query.numResults,
        tbs: query.tbs,
        filter: query.filter,
        lang: query.lang,
        country: query.country,
        location: query.location,
        safe: query.safe,
      };
      if (query.page !== undefined) {
        v2Options.page = query.page;
      }
      const web = filterWebByDomains(
        await searxng_search_v2(query.query, v2Options),
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
export const coreSearchProviders: ReadonlyArray<SearchProvider> = Object.freeze(
  coreSearchProviderSpecs.map(spec => {
    const impl = providerImplementations[spec.name];
    const entry: SearchProvider = spec.supportsUsOnly
      ? {
          name: spec.name,
          priority: spec.priority,
          supportsUsOnly: true,
          enabled: impl.enabled,
          search: impl.search,
        }
      : {
          name: spec.name,
          priority: spec.priority,
          enabled: impl.enabled,
          search: impl.search,
        };
    return Object.freeze(entry);
  }),
);
