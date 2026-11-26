import {
  matchesDomains as nativeMatchesDomains,
  matchesQueryOperators as nativeMatchesQueryOperators,
  parseQueryOperators as nativeParseQueryOperators,
  planOperatorQuery as nativePlanOperatorQuery,
  siteHostnames as nativeSiteHostnames,
  usesSearchSyntax as nativeUsesSearchSyntax,
} from "@mendable/firecrawl-rs";

/**
 * Query operators the search API enforces on returned results, because
 * providers apply site: combined with inurl: or intitle: inconsistently.
 */

export interface QueryOperators {
  sites: string[];
  excludedSites: string[];
  inurl: string[];
  intitle: string[];
  excludedInurl: string[];
  excludedIntitle: string[];
}

export interface OperatorPlan {
  /** The query sent to the provider. */
  query: string;
  operators: QueryOperators;
  /** inurl:/intitle: were stripped from the query and are enforced on results instead. */
  relaxed: boolean;
}

/**
 * True when the query uses search syntax: a quoted phrase, a `name:value`
 * token such as `site:` or `filetype:`, or an OR or `|` between terms. A
 * routed search sends the query text alone, so it carries none of these.
 */
export function usesSearchSyntax(query: string): boolean {
  return nativeUsesSearchSyntax(query);
}

export function parseQueryOperators(query: string): QueryOperators {
  return nativeParseQueryOperators(query);
}

/**
 * Providers return empty or partly filtered results when site: is combined
 * with inurl: or intitle:, so that combination is sent as site: plus plain
 * terms and the inurl:/intitle: filters are applied to the returned results.
 */
export function planOperatorQuery(query: string): OperatorPlan {
  return nativePlanOperatorQuery(query);
}

/** Hostnames from site: operators, for the provider-side domain filter. */
export function siteHostnames(sites: string[]): string[] {
  return nativeSiteHostnames(sites);
}

/** True when the URL's host is, or is under, an included domain and no excluded one. */
export function matchesDomains(
  url: string | undefined,
  includeDomains: string[] = [],
  excludeDomains: string[] = [],
): boolean {
  return nativeMatchesDomains(url, includeDomains, excludeDomains);
}

export function matchesQueryOperators(
  result: { url?: string | null; title?: string | null },
  plan: OperatorPlan,
): boolean {
  return nativeMatchesQueryOperators(result.url, result.title, plan);
}
