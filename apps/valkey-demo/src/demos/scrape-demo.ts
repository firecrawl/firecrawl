import { FirecrawlClient } from '../firecrawl-client';
import { CacheService } from '../services/cache-service';
import { getValkeyClient, closeValkeyClient } from '../valkey-client';

/**
 * Demo: Web scraping with Valkey GLIDE caching
 * Shows how to cache scrape results to avoid redundant API calls
 */
export async function runScrapeDemo(): Promise<void> {
  console.log('\n=== Scrape Demo with Valkey GLIDE Caching ===\n');

  const firecrawl = new FirecrawlClient();
  const cache = new CacheService(300); // 5 minute TTL for demo
  const testUrl = 'https://example.com';

  try {
    // Connect to Valkey
    const client = await getValkeyClient();
    await client.ping();
    console.log('[Demo] Connected to Valkey via GLIDE\n');

    // First scrape - should be a cache miss
    console.log('[Demo] First scrape (expecting cache miss)...');
    let result = await cache.getCachedScrape(testUrl);
    
    if (!result) {
      console.log('[Demo] Calling Firecrawl API...');
      result = await firecrawl.scrape(testUrl, { formats: ['markdown'] });
      
      if (result.success) {
        await cache.cacheScrapeResult(testUrl, result);
        console.log('[Demo] Scrape successful, result cached');
        console.log(`[Demo] Content preview: ${result.data?.markdown?.slice(0, 200)}...`);
      } else {
        console.log(`[Demo] Scrape failed: ${result.error}`);
      }
    }

    // Second scrape - should be a cache hit
    console.log('\n[Demo] Second scrape (expecting cache hit)...');
    const cachedResult = await cache.getCachedScrape(testUrl);
    
    if (cachedResult) {
      console.log('[Demo] Retrieved from cache - no API call needed!');
    }

    // Show cache stats
    const stats = await cache.getStats();
    console.log(`\n[Demo] Cache stats: ${stats.keys} keys, ${stats.memoryUsage} memory used`);

  } finally {
    await closeValkeyClient();
  }
}

// Run if executed directly
if (require.main === module) {
  runScrapeDemo().catch(console.error);
}
