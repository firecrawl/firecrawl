import { z } from 'zod';

import { firecrawlRoute } from '@/lib/firecrawl-route';

const Body = z.object({
  url: z.string().min(1),
  options: z.record(z.unknown()).optional(),
});

export const POST = firecrawlRoute('crawl', Body, (svc, { url, options }) =>
  svc.startCrawl(url, options),
);
