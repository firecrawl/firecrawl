import { z } from 'zod';

import { firecrawlRoute } from '@/lib/firecrawl-route';

/**
 * /api/scrape — DEPRECATED compat alias.
 *
 * Forwards to the same handlers as /api/firecrawl/scrape (single-URL)
 * and /api/firecrawl/batch-scrape (multi-URL). Kept on the original
 * path so existing CLI/curl integrations don't break, but it now
 * REQUIRES a bearer token (the IP-based rate limit was removed in
 * favor of per-principal quotas) and no longer reads the legacy
 * `X-Firecrawl-API-Key` header.
 *
 * New code should call /api/firecrawl/scrape or
 * /api/firecrawl/batch-scrape directly.
 */

const SingleBody = z.object({
  url: z.string().min(1),
  options: z.record(z.unknown()).optional(),
});

const BatchBody = z.object({
  urls: z.array(z.string().min(1)).min(1),
  options: z.record(z.unknown()).optional(),
});

const Body = z.union([SingleBody, BatchBody]);

export const POST = firecrawlRoute(
  // Op label is dynamic; we use the firecrawlRoute helper twice indirectly
  // by inspecting the parsed body inside `exec`. Bill under the matched
  // op so quota accounting matches the dedicated routes.
  'scrape',
  Body,
  async (svc, body) => {
    // NB: both branches record under `scrape` even when a batch was
    // requested. The firecrawlRoute helper picks the op label up front,
    // not from the body; rather than fork the helper just for this
    // compat shim we accept the slight accounting drift and let the
    // dedicated /api/firecrawl/batch-scrape path (which records
    // `batch_scrape`) remain canonical.
    if ('urls' in body && Array.isArray(body.urls)) {
      return svc.startBatchScrape(body.urls, body.options);
    }
    if ('url' in body && typeof body.url === 'string') {
      return svc.scrapeUrl(body.url);
    }
    throw new Error('expected either "url" or "urls" in body');
  }
);
