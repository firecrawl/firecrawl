// Placeholder v2 example (JavaScript)
// Minimal usage of new FirecrawlClient. Replace with your API key before running.

import { FirecrawlClient } from './firecrawl/src/v2/client.js';

async function run() {
  const apiKey = (globalThis.process && globalThis.process.env && globalThis.process.env.FIRECRAWL_API_KEY) || 'fc-YOUR_API_KEY';
  const client = new FirecrawlClient({ apiKey });

  const doc = await client.scrape('https://docs.firecrawl.dev', { formats: ['markdown'] });
  console.log('scrape:', !!doc.markdown);

  const crawl = await client.crawl('https://docs.firecrawl.dev', { limit: 3, pollInterval: 1, timeout: 120 });
  console.log('crawl:', crawl.status, crawl.completed, '/', crawl.total);

  const batch = await client.batchScrape([
    'https://docs.firecrawl.dev',
    'https://firecrawl.dev',
  ], { options: { formats: ['markdown'] }, pollInterval: 1, timeout: 120 });
  console.log('batch:', batch.status, batch.completed, '/', batch.total);

  const search = await client.search('What is the capital of France?', { limit: 5 });
  console.log('search web results:', (search.web || []).length);

  const map = await client.map('https://firecrawl.dev');
  console.log('map links:', map.links.length);
}

run().catch((e) => {
  console.error(e);
  if (globalThis.process && globalThis.process.exit) globalThis.process.exit(1);
});
