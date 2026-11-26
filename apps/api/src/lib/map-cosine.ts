import { rankCosineSimilarityIndices } from "@mendable/firecrawl-rs";
import { logger } from "./logger";
import { MapDocument } from "../controllers/v2/types";

export function performCosineSimilarity(links: string[], searchQuery: string) {
  try {
    const order = rankCosineSimilarityIndices(links, searchQuery);
    return order.map(index => links[index]);
  } catch (error) {
    logger.error(`Error performing cosine similarity: ${error}`);
    return links;
  }
}

export function performCosineSimilarityV2(
  links: MapDocument[],
  searchQuery: string,
) {
  try {
    const urls = links.map(link => link.url);
    const order = rankCosineSimilarityIndices(urls, searchQuery);
    return order.map(index => links[index]);
  } catch (error) {
    logger.error(`Error performing cosine similarity: ${error}`);
    return links;
  }
}
