import { FirecrawlClient } from '../firecrawl-client';
import { CacheService } from '../services/cache-service';
import { getValkeyClient, closeValkeyClient } from '../valkey-client';

/**
 * Demo: Web crawling with Valkey GLIDE state tracking
 * Shows how to track crawl progress and cache results
 */
export async function runCrawlDemo(): Promise<void> {
  console.log('\n=== Crawl Demo with Valkey GLIDE State Tracking ===\n');

  const firecrawl = new FirecrawlClient();
  const cache = new CacheService();
  const testUrl = 'https://example.com';

  try {
    const client = await getValkeyClient();
    await client.ping();
    console.log('[Demo] Connected to Valkey via GLIDE\n');

    // Start a crawl
    console.log(`[Demo] Starting crawl of ${testUrl}...`);
    const crawlResult = await firecrawl.crawl(testUrl, { limit: 5 });

    if (!crawlResult.success || !crawlResult.id) {
      console.log(`[Demo] Failed to start crawl: ${crawlResult.error}`);
      return;
    }

    const crawlId = crawlResult.id;
    console.log(`[Demo] Crawl started with ID: ${crawlId}`);

    // Store crawl ID in Valkey for tracking
    await client.hset('demo:crawls:active', [{ 
      field: crawlId, 
      value: JSON.stringify({ url: testUrl, startedAt: Date.now() })
    }]);

    // Poll for completion
    console.log('[Demo] Polling for crawl completion...');
    let status = await firecrawl.getCrawlStatus(crawlId);
    let attempts = 0;
    const maxAttempts = 30;

    while (status.status !== 'completed' && status.status !== 'failed' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      status = await firecrawl.getCrawlStatus(crawlId);
      attempts++;
      console.log(`[Demo] Status: ${status.status} (attempt ${attempts}/${maxAttempts})`);
    }

    if (status.status === 'completed') {
      console.log(`\n[Demo] Crawl completed! Found ${status.data?.length || 0} pages`);
      
      // Cache the result
      await cache.cacheCrawlResult(crawlId, status);
      
      // Show sample results
      status.data?.slice(0, 3).forEach((page, i) => {
        console.log(`[Demo] Page ${i + 1}: ${page.url}`);
      });

      // Move from active to completed in Valkey
      await client.hdel('demo:crawls:active', [crawlId]);
      await client.hset('demo:crawls:completed', [{
        field: crawlId,
        value: JSON.stringify({
          url: testUrl,
          completedAt: Date.now(),
          pageCount: status.data?.length || 0,
        })
      }]);
    } else {
      console.log(`[Demo] Crawl ended with status: ${status.status}`);
    }

  } finally {
    await closeValkeyClient();
  }
}

if (require.main === module) {
  runCrawlDemo().catch(console.error);
}
