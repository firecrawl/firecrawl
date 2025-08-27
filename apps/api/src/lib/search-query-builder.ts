/**
 * Search Query Builder
 * Builds search queries with category filters for the search API
 */

export interface CategoryInput {
  type: 'github' | 'research';
  sites?: string[];
}

export type CategoryOption = string | CategoryInput;

export interface QueryBuilderResult {
  query: string;
  categoryMap: Map<string, string>;
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
  "medrxiv.org"
];

/**
 * Builds a search query with category filters
 * @param baseQuery The base search query
 * @param categories Optional array of categories to filter by
 * @returns The final query string and a map of sites to categories
 */
export function buildSearchQuery(
  baseQuery: string,
  categories?: CategoryOption[]
): QueryBuilderResult {
  const categoryMap = new Map<string, string>();
  
  if (!categories || categories.length === 0) {
    return {
      query: baseQuery,
      categoryMap
    };
  }

  const siteFilters: string[] = [];
  
  for (const category of categories) {
    if (typeof category === 'string') {
      // Simple string format
      if (category === 'github') {
        siteFilters.push("site:github.com");
        categoryMap.set("github.com", "github");
      } else if (category === 'research') {
        // Use default research sites
        for (const site of DEFAULT_RESEARCH_SITES) {
          siteFilters.push(`site:${site}`);
          categoryMap.set(site, "research");
        }
      }
    } else {
      // Object format with options
      if (category.type === 'github') {
        siteFilters.push("site:github.com");
        categoryMap.set("github.com", "github");
      } else if (category.type === 'research') {
        // Use custom sites if provided, otherwise defaults
        const sites = category.sites || DEFAULT_RESEARCH_SITES;
        for (const site of sites) {
          siteFilters.push(`site:${site}`);
          categoryMap.set(site, "research");
        }
      }
    }
  }
  
  // Build the OR filter for sites
  let categoryFilter = "";
  if (siteFilters.length > 0) {
    categoryFilter = " (" + siteFilters.join(" OR ") + ")";
  }
  
  return {
    query: baseQuery + categoryFilter,
    categoryMap
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
  categoryMap: Map<string, string>
): string | undefined {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    // Direct match for GitHub
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
      return 'github';
    }
    
    // Check against category map for other sites
    for (const [site, category] of categoryMap.entries()) {
      if (hostname === site.toLowerCase() || hostname.endsWith('.' + site.toLowerCase())) {
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
