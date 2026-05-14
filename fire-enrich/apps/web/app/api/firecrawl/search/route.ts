import { z } from 'zod';

import { firecrawlRoute } from '@/lib/firecrawl-route';

const Body = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
  scrapeContent: z.boolean().optional(),
});

export const POST = firecrawlRoute('search', Body, (svc, { query, limit, scrapeContent }) =>
  svc.search(query, { limit, scrapeContent }),
);
