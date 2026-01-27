import { BatchManager } from '../services/batch-manager';
import { getValkeyClient, closeValkeyClient } from '../valkey-client';

/**
 * Demo: Batch operations with Valkey GLIDE state management
 * Shows batch scraping with progress tracking and caching
 */
export async function runBatchDemo(): Promise<void> {
  console.log('\n=== Batch Operations Demo with Valkey GLIDE ===\n');

  const batchManager = new BatchManager();
  
  const urls = [
    'https://example.com',
    'https://example.org',
    'https://example.net',
  ];

  try {
    const client = await getValkeyClient();
    await client.ping();
    console.log('[Demo] Connected to Valkey via GLIDE\n');

    // Create a batch job
    console.log(`[Demo] Creating batch job for ${urls.length} URLs...`);
    const batchId = await batchManager.createBatch(urls);
    console.log(`[Demo] Batch ID: ${batchId}\n`);

    // Check active batches
    const activeBatches = await batchManager.listActiveBatches();
    console.log(`[Demo] Active batches: ${activeBatches.length}`);

    // Process the batch
    console.log('\n[Demo] Processing batch (with rate limiting and caching)...\n');
    const result = await batchManager.processBatch(batchId, 2);

    // Show results
    console.log(`\n[Demo] Batch completed!`);
    console.log(`[Demo] Status: ${result.status}`);
    console.log(`[Demo] Duration: ${result.completedAt! - result.createdAt}ms`);
    console.log(`[Demo] Results:`);
    
    for (const [url, scrapeResult] of Object.entries(result.results)) {
      const status = scrapeResult.success ? '✅' : '❌';
      const preview = scrapeResult.data?.markdown?.slice(0, 50) || scrapeResult.error || 'No content';
      console.log(`  ${status} ${url}: ${preview}...`);
    }

    // Verify batch status from Valkey
    const storedStatus = await batchManager.getBatchStatus(batchId);
    console.log(`\n[Demo] Stored status in Valkey: ${storedStatus?.status}`);

  } finally {
    await closeValkeyClient();
  }
}

if (require.main === module) {
  runBatchDemo().catch(console.error);
}
