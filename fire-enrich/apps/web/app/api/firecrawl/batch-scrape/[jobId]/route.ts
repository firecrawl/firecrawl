import { FirecrawlService } from '@fire-enrich/core';
import {
  NoKeyAvailableError,
  QuotaExceededError,
  withBearer,
  withFirecrawl,
} from '@fire-enrich/core/server';
import { getDb } from '@fire-enrich/db';

type RouteContext = { params: Promise<{ jobId: string }> };

/**
 * Single-shot status of a batch-scrape job. The playground polls this
 * every 2s from the client; we don't expose an SSE variant here because
 * batch jobs are typically much shorter than crawls and the polling cost
 * is bounded by the client.
 */
export const GET = async (req: Request, ctx: RouteContext) => {
  const { jobId } = await ctx.params;
  if (!jobId) {
    return Response.json(
      { code: 'invalid_request', error: 'missing jobId' },
      { status: 400 },
    );
  }

  const handler = withBearer(async (_r, { principal }) => {
    const db = getDb();
    try {
      const result = await withFirecrawl(
        principal,
        'job_status',
        db,
        async (key) => {
          const svc = new FirecrawlService(key.key);
          return svc.getBatchScrapeStatus(jobId);
        },
      );
      return Response.json(result);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return Response.json(
          { code: err.code, error: err.message },
          { status: 429 },
        );
      }
      if (err instanceof NoKeyAvailableError) {
        return Response.json(
          { code: err.code, error: err.message },
          { status: 503 },
        );
      }
      const msg = err instanceof Error ? err.message : 'status failed';
      return Response.json(
        { code: 'firecrawl_error', error: msg },
        { status: 502 },
      );
    }
  });
  return handler(req, { db: getDb() });
};
