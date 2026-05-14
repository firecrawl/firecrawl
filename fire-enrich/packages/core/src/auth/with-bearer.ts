import type { Principal } from '@fire-enrich/db';

import { UnauthorizedError, requireBearer } from './bearer.js';

export interface WithBearerContext<TExtra = unknown> {
  principal: Principal;
  /** Whatever the caller passed in as ctx (typically `{ db, ... }`). */
  extra: TExtra;
}

export type BearerHandler<TExtra = unknown> = (
  req: Request,
  ctx: WithBearerContext<TExtra>,
) => Promise<Response> | Response;

/**
 * Wrap a route handler so it only runs after a valid bearer token has
 * been resolved. Returns a 401 JSON Response on any UnauthorizedError;
 * other errors propagate.
 *
 * Usage:
 *   export const POST = withBearer(async (req, { principal, extra }) => {
 *     ...
 *   });
 *
 * Wire `extra` (and the db) at the route boundary by closing over them
 * in the handler, OR by passing `{ db, ...other }` as the second arg
 * when invoking the wrapped function. The standalone shape is convenient
 * for tests.
 */
export function withBearer<TExtra = unknown>(
  handler: BearerHandler<TExtra>,
): (req: Request, ctx: { db: unknown } & Partial<TExtra>) => Promise<Response> {
  return async (req, ctx) => {
    try {
      const principal = await requireBearer(req.headers, ctx.db);
      return await handler(req, { principal, extra: ctx as unknown as TExtra });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return new Response(
          JSON.stringify({ code: err.code, error: err.message }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      throw err;
    }
  };
}
