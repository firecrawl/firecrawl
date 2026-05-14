import { FirecrawlService } from '../services/firecrawl.js';
import type { SearchResult } from '../types/index.js';

export async function searchWeb({ query, limit, scrapeContent, firecrawl }: {
  query: string;
  limit?: number;
  scrapeContent?: boolean;
  firecrawl: FirecrawlService;
}): Promise<SearchResult[]> {
  return firecrawl.search(query, { limit, scrapeContent });
}
