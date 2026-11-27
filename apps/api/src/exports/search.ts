export { executeSearch } from "../search/execute";
export { searchWithProvider } from "../lib/search-metrics";
export { search as searchV2 } from "../search/v2/index";
export {
  scrapeSearchResults,
  type DocumentWithCostTracking,
} from "../search/scrape";
export { applySearchPlanHook } from "../search/plan-hook";
export { usesSearchSyntax } from "../search/operators";
export {
  buildSearchQuery,
  hasCategory,
  type CategoryOption,
} from "../lib/search-query-builder";
