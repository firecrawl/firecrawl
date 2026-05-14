import { z, ZodError } from 'zod';

import { FirecrawlService } from '@fire-enrich/core';
import {
  NoKeyAvailableError,
  QuotaExceededError,
  UnauthorizedError,
  withBearer,
  withFirecrawl,
  type FirecrawlOp,
} from '@fire-enrich/core/server';
import { getDb, type Principal } from '@fire-enrich/db';

/**
 * Build a Next.js POST handler for /api/firecrawl/<op>.
 *
 * The wrapper handles:
 *   - Bearer-token auth (401 on missing/invalid)
 *   - Body parsing via zod (400 on invalid)
 *   - Key resolution + quota enforcement (429 on quota, 503 on no-key)
 *   - Usage accounting (records ok=1/0 in usage_events)
 *   - Firecrawl errors → 502 with a structured body
 *
 * Each route file just declares its op, body schema, and how to call
 * the service. Everything else is in this helper.
 */
export function firecrawlRoute<T extends z.ZodTypeAny>(
  op: FirecrawlOp,
  schema: T,
  exec: (
    svc: FirecrawlService,
    body: z.infer<T>,
    principal: Principal,
  ) => Promise<unknown>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const handler = withBearer(async (r, { principal }) => {
      let body: z.infer<T>;
      try {
        const json = await r.json();
        body = schema.parse(json);
      } catch (err) {
        const msg =
          err instanceof ZodError
            ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : err instanceof Error
              ? err.message
              : 'invalid body';
        return Response.json(
          { code: 'invalid_request', error: msg },
          { status: 400 },
        );
      }

      const db = getDb();
      try {
        const result = await withFirecrawl(principal, op, db, async (key) => {
          const svc = new FirecrawlService(key.key);
          return exec(svc, body, principal);
        });
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
        const msg = err instanceof Error ? err.message : 'unknown firecrawl error';
        console.error('firecrawl route error', { op, err });
        return Response.json(
          { code: 'firecrawl_error', error: msg },
          { status: 502 },
        );
      }
    });
    return handler(req, { db: getDb() });
  };
}

export { UnauthorizedError, QuotaExceededError, NoKeyAvailableError };
