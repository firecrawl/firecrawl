import {
  buildSearchQuery as nativeBuildSearchQuery,
  getCategoryFromUrl as nativeGetCategoryFromUrl,
  getDefaultResearchSites as nativeGetDefaultResearchSites,
  type SearchCategoryInput,
} from "@mendable/firecrawl-rs";

/**
 * Search Query Builder
 * Builds search queries with category filters for the search API
 */

interface CategoryInput {
  type: "research" | "pdf" | "developer" | "gov";
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

export function hasCategory(
  categories: unknown,
  type: CategoryInput["type"] | "github",
): boolean {
  return (
    Array.isArray(categories) &&
    categories.some(c => (typeof c === "string" ? c : c?.type) === type)
  );
}

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
  const nativeCategories: SearchCategoryInput[] | undefined = categories
    ? categories.reduce<SearchCategoryInput[]>((acc, category) => {
        if (typeof category === "string") {
          acc.push({ categoryType: category });
        } else if (category && typeof category.type === "string") {
          acc.push({
            categoryType: category.type,
            sites: category.sites,
          });
        }
        return acc;
      }, [])
    : undefined;

  const result = nativeBuildSearchQuery(
    baseQuery,
    nativeCategories,
    domainOptions.includeDomains,
    domainOptions.excludeDomains,
  );

  return {
    query: result.query,
    categoryMap: new Map(
      result.categoryEntries.map(({ site, category }) => [site, category]),
    ),
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
  const entries = Array.from(categoryMap.entries(), ([site, category]) => ({
    site,
    category,
  }));
  return nativeGetCategoryFromUrl(url, entries) ?? undefined;
}

/**
 * Get default research sites
 */
export function getDefaultResearchSites(): string[] {
  return nativeGetDefaultResearchSites();
}
