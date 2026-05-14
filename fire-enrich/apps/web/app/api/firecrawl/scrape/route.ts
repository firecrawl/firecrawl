import { z } from 'zod';

import { firecrawlRoute } from '@/lib/firecrawl-route';

const Body = z.object({
  url: z.string().min(1),
});

export const POST = firecrawlRoute('scrape', Body, (svc, { url }) =>
  svc.scrapeUrl(url),
);
