import { FirecrawlService } from '@fire-enrich/core';
import {
  NoKeyAvailableError,
  QuotaExceededError,
  withBearer,
  withFirecrawl,
} from '@fire-enrich/core/server';
import { getDb } from '@fire-enrich/db';

const POLL_INTERVAL_MS = 2000;
const MAX_DURATION_MS = 60 * 60 * 1000; // 1 hour cap

type RouteContext = { params: Promise<{ jobId: string }> };

/**
 * SSE stream of crawl status. Polls FirecrawlService.getCrawlStatus
 * every 2 seconds, emits each status as a `data: <json>\n\n` event,
 * and closes the stream when status is `completed`, `failed`, or
 * `cancelled`. The client can also disconnect at any time — the
 * AbortSignal closes the polling loop.
 */
export const GET = async (req: Request, ctx: RouteContext) => {
  const { jobId } = await ctx.params;
  if (!jobId) {
    return Response.json(
      { code: 'invalid_request', error: 'missing jobId' },
      { status: 400 },
    );
  }

  const handler = withBearer(async (r, { principal }) => {
    const db = getDb();

    let svc: FirecrawlService;
    try {
      svc = await withFirecrawl(principal, 'job_status', db, async (key) => {
        return new FirecrawlService(key.key);
      });
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
      throw err;
    }

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (data: unknown) => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        const startedAt = Date.now();
        let aborted = false;
        r.signal.addEventListener('abort', () => {
          aborted = true;
        });

        try {
          while (!aborted && Date.now() - startedAt < MAX_DURATION_MS) {
            let status: { status?: string } & Record<string, unknown>;
            try {
              status = (await svc.getCrawlStatus(jobId)) as typeof status;
            } catch (err) {
              send({
                event: 'error',
                code: 'status_failed',
                error: err instanceof Error ? err.message : 'unknown error',
              });
              break;
            }
            send(status);
            const s = status.status;
            if (s === 'completed' || s === 'failed' || s === 'cancelled') {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
          if (Date.now() - startedAt >= MAX_DURATION_MS) {
            send({ event: 'error', code: 'timeout', error: 'max stream duration reached' });
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  });
  return handler(req, { db: getDb() });
};

/**
 * Cancel a running crawl. Returns { ok: boolean } from the upstream.
 */
export const DELETE = async (req: Request, ctx: RouteContext) => {
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
      const result = await withFirecrawl(principal, 'cancel_job', db, async (key) => {
        const svc = new FirecrawlService(key.key);
        return svc.cancelCrawl(jobId);
      });
      return Response.json(result);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return Response.json({ code: err.code, error: err.message }, { status: 429 });
      }
      if (err instanceof NoKeyAvailableError) {
        return Response.json({ code: err.code, error: err.message }, { status: 503 });
      }
      const msg = err instanceof Error ? err.message : 'cancel failed';
      return Response.json({ code: 'firecrawl_error', error: msg }, { status: 502 });
    }
  });
  return handler(req, { db: getDb() });
};
