import { createHmac, randomBytes, scryptSync } from 'node:crypto';

/**
 * Token + hashing contract for fire-enrich principals.
 *
 * Why this shape?
 * ---------------
 * Tokens are `fe_<24 random bytes base64url>` (35 chars). The `fe_` prefix
 * makes them grep-able in logs and helps reviewers spot accidental leaks.
 *
 * We never store the plaintext. Instead each row keeps:
 *   - `tokenPrefix` — first 11 chars (`fe_xxxxxxxx`), shown in admin UI as a
 *     preview and used as the input to salt derivation.
 *   - `tokenSalt`   — `HMAC-SHA256(SERVER_PEPPER, tokenPrefix)`. Deterministic
 *     so the auth path can recompute it from `tokenPrefix` alone, but it
 *     still requires the server-side pepper to forge.
 *   - `tokenHash`   — `scrypt(plaintext, salt, 64, { N: 16384, r: 8, p: 1 })`,
 *     uniqueness-indexed so verification is a single O(log n) lookup
 *     instead of iterating every row.
 *
 * The deterministic salt is the key trick: traditional per-user random
 * salts would force a full-table scan + scrypt-per-row to authenticate
 * a bearer, which doesn't scale. By making the salt a function of the
 * (public) prefix and the (server-secret) pepper, we keep scrypt's
 * brute-force resistance while still permitting indexed lookup.
 */

const TOKEN_PREFIX = 'fe_';
const TOKEN_PREFIX_LEN = 11; // "fe_" + 8 chars of body
const TOKEN_BODY_BYTES = 24;

// scrypt cost parameters — keep in sync with the docstring above and
// the migration that creates the principals table.
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;

/**
 * Generate a fresh principal token. Format: `fe_<24B base64url>` (35 chars).
 */
export function generateToken(): string {
  const body = randomBytes(TOKEN_BODY_BYTES).toString('base64url');
  return `${TOKEN_PREFIX}${body}`;
}

/**
 * Public preview of a token: `fe_xxxxxxxx` (11 chars). Safe to log and
 * to surface in admin UI.
 */
export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LEN);
}

/**
 * Derive a deterministic per-token salt from the (public) prefix and the
 * (server-secret) `SERVER_PEPPER` env var.
 *
 * Throws when `SERVER_PEPPER` is unset or empty — this is a hard
 * requirement; running without it would silently regress the security
 * model into "scrypt without a salt".
 */
export function deriveSalt(prefix: string): string {
  const pepper = process.env.SERVER_PEPPER;
  if (!pepper || pepper.length === 0) {
    throw new Error('SERVER_PEPPER env var not set');
  }
  return createHmac('sha256', pepper).update(prefix).digest('base64');
}

/**
 * Hash a plaintext token with the given salt using scrypt
 * (N=2^14, r=8, p=1, keylen=64). The output is base64-encoded.
 */
export function hashToken(token: string, salt: string): string {
  return scryptSync(token, salt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString('base64');
}
