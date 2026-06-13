import { logger } from "./logger";
import { MapDocument } from "../controllers/v2/types";

const TOKEN_REGEX = /[\p{L}\p{N}]+/gu;

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function tokenize(value: string): string[] {
  return (
    safeDecodeURIComponent(value)
      .toLowerCase()
      .normalize("NFC")
      .match(TOKEN_REGEX) ?? []
  );
}

function termFrequency(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (vec1.length !== vec2.length || vec1.length === 0) return 0;

  const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
  const magnitude1 = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
  const magnitude2 = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
  if (magnitude1 === 0 || magnitude2 === 0) return 0;
  return dotProduct / (magnitude1 * magnitude2);
}

function rankByCosine<T>(
  items: T[],
  searchQuery: string,
  toText: (item: T) => string,
): T[] {
  const queryTokens = tokenize(searchQuery);
  if (queryTokens.length === 0) {
    return items;
  }

  const queryFrequency = termFrequency(queryTokens);
  const vocabulary = Array.from(queryFrequency.keys());
  const searchVector = vocabulary.map(token => queryFrequency.get(token) ?? 0);

  return items
    .map(item => {
      const itemFrequency = termFrequency(tokenize(toText(item)));
      const itemVector = vocabulary.map(token => itemFrequency.get(token) ?? 0);
      return {
        item,
        score: cosineSimilarity(itemVector, searchVector),
      };
    })
    .sort((a, b) => b.score - a.score)
    .map(result => result.item);
}

export function performCosineSimilarity(links: string[], searchQuery: string) {
  try {
    return rankByCosine(links, searchQuery, link => link);
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
    return rankByCosine(links, searchQuery, link => link.url);
  } catch (error) {
    logger.error(`Error performing cosine similarity: ${error}`);
    return links;
  }
}
