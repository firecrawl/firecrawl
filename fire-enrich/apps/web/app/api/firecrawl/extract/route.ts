import { z } from 'zod';

import { firecrawlRoute } from '@/lib/firecrawl-route';

const Body = z.object({
  urls: z.array(z.string().min(1)).min(1),
  prompt: z.string().optional(),
  schema: z.record(z.unknown()).optional(),
  showSources: z.boolean().optional(),
});

// The zod schema enforces urls.min(1) at runtime; the cast widens the
// inferred Partial<> coming from the generic helper into the FirecrawlService
// signature (urls is required there).
export const POST = firecrawlRoute('extract', Body, (svc, body) =>
  svc.extract({
    urls: body.urls as string[],
    prompt: body.prompt,
    schema: body.schema,
    showSources: body.showSources,
  }),
);
