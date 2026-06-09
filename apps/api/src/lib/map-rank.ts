import { MapDocument, MAX_MAP_LIMIT } from "../controllers/v2/types";
import { performCosineSimilarityV2 } from "./map-cosine";

/**
 * Rank map results by relevance to the search query and cap them to the limit.
 *
 * When a search query is provided the cosine ranking must run *before* the
 * cutoff: otherwise the slice keeps the first N links in their original
 * (arbitrary) order, so relevant pages further down never get scored and are
 * dropped before ranking. With no search query the order is preserved. (#3335)
 */
export function rankAndCapMapResults(
  mapResults: MapDocument[],
  search: string | undefined,
  limit: number,
): MapDocument[] {
  if (search) {
    mapResults = performCosineSimilarityV2(mapResults, search.toLowerCase());
  }

  const minimumCutoff = Math.min(MAX_MAP_LIMIT, limit);
  if (mapResults.length > minimumCutoff) {
    mapResults = mapResults.slice(0, minimumCutoff);
  }

  return mapResults;
}
