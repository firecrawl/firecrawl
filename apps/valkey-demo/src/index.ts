import { runScrapeDemo } from './demos/scrape-demo';
import { runCrawlDemo } from './demos/crawl-demo';
import { runRateLimitDemo } from './demos/rate-limit-demo';
import { runBatchDemo } from './demos/batch-demo';
import { closeValkeyClient } from './valkey-client';

async function runAllDemos(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Firecrawl + Valkey Demo Application                    ║');
  console.log('║     Demonstrating caching, rate limiting, and batching     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const demos = [
    { name: 'Rate Limiting', fn: runRateLimitDemo },
    { name: 'Scrape with Caching', fn: runScrapeDemo },
    { name: 'Crawl with State Tracking', fn: runCrawlDemo },
    { name: 'Batch Operations', fn: runBatchDemo },
  ];

  for (const demo of demos) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Running: ${demo.name}`);
    console.log('─'.repeat(60));
    
    try {
      await demo.fn();
    } catch (error: any) {
      console.error(`[Error] ${demo.name} failed: ${error.message}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('All demos completed!');
  console.log('═'.repeat(60));
}

// Parse command line args for individual demos
const arg = process.argv[2];

async function main(): Promise<void> {
  try {
    switch (arg) {
      case 'scrape':
        await runScrapeDemo();
        break;
      case 'crawl':
        await runCrawlDemo();
        break;
      case 'rate-limit':
        await runRateLimitDemo();
        break;
      case 'batch':
        await runBatchDemo();
        break;
      default:
        await runAllDemos();
    }
  } finally {
    await closeValkeyClient();
  }
}

main().catch(console.error);
