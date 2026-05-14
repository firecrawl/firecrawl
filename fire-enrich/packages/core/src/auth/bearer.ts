import type { Principal } from '@fire-enrich/db';
import { findByTokenHash } from '@fire-enrich/db';

export class UnauthorizedError extends Error {
  readonly code = 'unauthorized' as const;
  readonly reason: string;
  constructor(reason: string) {
    super(`Unauthorized: ${reason}`);
    this.reason = reason;
  }
}

/**
 * Authenticate a request by its `Authorization: Bearer <token>` header.
 *
 * Input is plain `Headers` (not a NextRequest) so the same function
 * services Next route handlers, the future MCP HTTP transport, and
 * any other transport that can hand us a Headers-like bag.
 *
 * Failure modes (all map to `UnauthorizedError`):
 *   - missing Authorization header
 *   - malformed (not "Bearer <token>")
 *   - token does not start with the `fe_` prefix (cheap reject before
 *     touching the DB or the scrypt hasher)
 *   - token unknown OR principal revoked (handled by `findByTokenHash`,
 *     which filters on `revokedAt IS NULL`)
 */
export async function requireBearer(
  headers: Headers,
  db: unknown,
): Promise<Principal> {
  const auth = headers.get('authorization');
  if (!auth) throw new UnauthorizedError('missing Authorization header');

  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new UnauthorizedError('malformed Authorization header');

  const token = m[1]!.trim();
  if (!token.startsWith('fe_')) {
    throw new UnauthorizedError('invalid token format');
  }

  const principal = await findByTokenHash(token, db as never);
  if (!principal) throw new UnauthorizedError('token not found or revoked');
  return principal;
}
