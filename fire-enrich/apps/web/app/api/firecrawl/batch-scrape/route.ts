import { z } from 'zod';

import { firecrawlRoute } from '@/lib/firecrawl-route';

const Body = z.object({
  urls: z.array(z.string().min(1)).min(1),
  options: z.record(z.unknown()).optional(),
});

export const POST = firecrawlRoute('batch_scrape', Body, (svc, { urls, options }) =>
  svc.startBatchScrape(urls, options),
);
