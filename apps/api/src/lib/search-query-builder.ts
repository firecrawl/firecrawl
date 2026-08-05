/**
 * Search Query Builder
 * Builds search queries with category filters for the search API
 */

interface CategoryInput {
  type: "github" | "research" | "pdf" | "developer";
  sites?: string[];
}

export type CategoryOption = string | CategoryInput;

interface DomainFilterOptions {
  includeDomains?: string[];
  excludeDomains?: string[];
}

interface QueryBuilderResult {
  query: string;
  categoryMap: Map<string, string>;
}

interface SitePathFilterResult {
  query: string;
  pathPrefixes: string[];
}

/**
 * Rewrites path-scoped `site:` operators to their hostname.
 *
 * `site:host/path` acts as a strict URL-prefix restriction, so a stale or
 * guessed path (or one with query parameters) returns zero results even when
 * the site has relevant pages. This rewrite is
 * the fallback for that case: `site:host` keeps the domain restriction, and
 * the extracted prefixes let the caller rank results under the requested path
 * first (see rankSitePathMatchesFirst). Callers should only fall back to the
 * rewritten query when the original one returned nothing — when the prefix
 * does match indexed pages, the provider's strict filtering is the better
 * result set.
 *
 * Negated operators (`-site:`) are left untouched: widening an exclusion to
 * the whole domain would drop results the user wanted.
 */
export function extractSitePathFilters(query: string): SitePathFilterResult {
  const pathPrefixes: string[] = [];
  const rewritten = query.replace(
    /(^|[^-\w])site:([^\s()"']+)/gi,
    (match, boundary: string, rawValue: string) => {
      const value = rawValue.replace(/^https?:\/\//i, "");
      const slash = value.indexOf("/");
      const host = slash === -1 ? value : value.slice(0, slash);
      const path = slash === -1 ? "" : value.slice(slash).replace(/\/+$/, "");
      if (!host.includes(".")) {
        return match;
      }
      if (path.length > 0) {
        pathPrefixes.push(
          host.toLowerCase().replace(/^www\./, "") + path.toLowerCase(),
        );
      }
      return `${boundary}site:${host}`;
    },
  );
  return { query: rewritten, pathPrefixes };
}

function urlMatchesSitePathPrefix(
  url: string | undefined,
  pathPrefixes: string[],
): boolean {
  if (!url) return false;
  let hostname: string;
  let pathname: string;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    pathname = parsed.pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return false;
  }
  for (const prefix of pathPrefixes) {
    const slash = prefix.indexOf("/");
    const prefixHost = slash === -1 ? prefix : prefix.slice(0, slash);
    const prefixPath = slash === -1 ? "" : prefix.slice(slash);
    if (hostname !== prefixHost && !hostname.endsWith("." + prefixHost)) {
      continue;
    }
    if (
      prefixPath === "" ||
      pathname === prefixPath ||
      pathname.startsWith(prefixPath + "/")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Reorders results so that URLs under a requested `site:host/path` prefix come
 * first, preserving relative order within each group. Results are never
 * dropped: the hostname rewrite in extractSitePathFilters already constrains
 * them to the right domain, and off-path pages are still better than the zero
 * results the original path-scoped query produced.
 */
export function rankSitePathMatchesFirst<T extends { url?: string }>(
  results: T[],
  pathPrefixes: string[],
): T[] {
  if (pathPrefixes.length === 0 || results.length === 0) {
    return results;
  }
  const onPath: T[] = [];
  const offPath: T[] = [];
  for (const result of results) {
    if (urlMatchesSitePathPrefix(result.url, pathPrefixes)) {
      onPath.push(result);
    } else {
      offPath.push(result);
    }
  }
  return onPath.length > 0 ? [...onPath, ...offPath] : results;
}

// Default research sites
const DEFAULT_RESEARCH_SITES = [
  "arxiv.org",
  "scholar.google.com",
  "pubmed.ncbi.nlm.nih.gov",
  "researchgate.net",
  "nature.com",
  "science.org",
  "ieee.org",
  "acm.org",
  "springer.com",
  "wiley.com",
  "sciencedirect.com",
  "plos.org",
  "biorxiv.org",
  "medrxiv.org",
];

/**
 * Builds a search query with category filters
 * @param baseQuery The base search query
 * @param categories Optional array of categories to filter by
 * @returns The final query string and a map of sites to categories
 */
export function buildSearchQuery(
  baseQuery: string,
  categories?: CategoryOption[],
  domainOptions: DomainFilterOptions = {},
): QueryBuilderResult {
  const categoryMap = new Map<string, string>();

  const siteFilters: string[] = [];
  let hasPdfFilter = false;

  for (const category of categories ?? []) {
    if (typeof category === "string") {
      // Simple string format
      if (category === "github") {
        siteFilters.push("site:github.com");
        categoryMap.set("github.com", "github");
      } else if (category === "research") {
        // Use default research sites
        for (const site of DEFAULT_RESEARCH_SITES) {
          siteFilters.push(`site:${site}`);
          categoryMap.set(site, "research");
        }
      } else if (category === "pdf") {
        hasPdfFilter = true;
        categoryMap.set("__pdf__", "pdf");
      }
    } else {
      // Object format with options
      if (category.type === "github") {
        siteFilters.push("site:github.com");
        categoryMap.set("github.com", "github");
      } else if (category.type === "research") {
        // Use custom sites if provided, otherwise defaults
        const sites = category.sites || DEFAULT_RESEARCH_SITES;
        for (const site of sites) {
          siteFilters.push(`site:${site}`);
          categoryMap.set(site, "research");
        }
      } else if (category.type === "pdf") {
        hasPdfFilter = true;
        categoryMap.set("__pdf__", "pdf");
      }
    }
  }

  // Build the OR filter for sites
  let categoryFilter = "";
  if (siteFilters.length > 0) {
    categoryFilter = " (" + siteFilters.join(" OR ") + ")";
  }

  // Add filetype:pdf filter if PDF category is requested
  if (hasPdfFilter) {
    categoryFilter += " filetype:pdf";
  }

  const includeDomains = domainOptions.includeDomains ?? [];
  const excludeDomains = domainOptions.excludeDomains ?? [];
  // Bare `site:` operators, not a parenthesized group: some backends don't
  // parse `(site:foo.com)` and drop the filter, leaking off-domain results.
  const includeFilter =
    includeDomains.length > 0
      ? " " + includeDomains.map(domain => `site:${domain}`).join(" OR ")
      : "";
  const excludeFilter =
    excludeDomains.length > 0
      ? " " + excludeDomains.map(domain => `-site:${domain}`).join(" ")
      : "";

  return {
    query: baseQuery + categoryFilter + includeFilter + excludeFilter,
    categoryMap,
  };
}

/**
 * Determines the category for a given URL
 * @param url The URL to categorize
 * @param categoryMap Map of hostnames to categories
 * @returns The category name or undefined
 */
export function getCategoryFromUrl(
  url: string,
  categoryMap: Map<string, string>,
): string | undefined {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const pathname = urlObj.pathname.toLowerCase();

    // Check if URL points to a PDF file
    if (pathname.endsWith(".pdf") && categoryMap.has("__pdf__")) {
      return "pdf";
    }

    // Direct match for GitHub
    if (hostname === "github.com" || hostname.endsWith(".github.com")) {
      return "github";
    }

    // Check against category map for other sites
    for (const [site, category] of categoryMap.entries()) {
      if (site === "__pdf__") continue; // Skip the special PDF marker

      if (
        hostname === site.toLowerCase() ||
        hostname.endsWith("." + site.toLowerCase())
      ) {
        return category;
      }
    }
  } catch (e) {
    // Invalid URL, skip
  }

  return undefined;
}

/**
 * Get default research sites
 */
export function getDefaultResearchSites(): string[] {
  return [...DEFAULT_RESEARCH_SITES];
}
