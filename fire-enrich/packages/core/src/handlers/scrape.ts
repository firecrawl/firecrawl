import { FirecrawlService } from '../services/firecrawl.js';

export async function scrapeUrl({ url, firecrawl }: {
  url: string;
  firecrawl: FirecrawlService;
}): Promise<{ markdown?: string; html?: string; error?: string }> {
  const result = await firecrawl.scrapeUrl(url);
  return result.data ?? { error: result.error };
}
