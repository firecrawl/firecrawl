import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE_NAME = '__fe_admin';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export class AdminUnauthorizedError extends Error {
  readonly code = 'admin_unauthorized' as const;
  constructor(reason: string) {
    super(`Admin unauthorized: ${reason}`);
  }
}

/**
 * Identity of the authenticated operator after `requireOperator()` succeeds.
 *
 * - `source: 'cf-access'` — request came through a trusted reverse proxy
 *   (Cloudflare Access via Traefik forwardAuth). `email` is the verified
 *   identity from the upstream JWT.
 * - `source: 'admin-token'` — legacy single-shared-secret cookie. The
 *   dashboard has no real per-user identity in this mode, so `email` is
 *   the literal string `"admin"`.
 */
export interface OperatorIdentity {
  email: string;
  source: 'cf-access' | 'admin-token';
}

type AuthMode = 'admin-token' | 'proxy' | 'either';

const PROXY_EMAIL_HEADER = 'x-auth-user-email';

function getAuthMode(): AuthMode {
  const raw = (process.env.OPS_AUTH_MODE ?? 'admin-token').trim().toLowerCase();
  if (raw === 'admin-token' || raw === 'proxy' || raw === 'either') return raw;
  throw new Error(
    `OPS_AUTH_MODE must be admin-token | proxy | either (got "${raw}")`,
  );
}

function getOperatorAllowlist(): Set<string> | null {
  const raw = process.env.OPERATOR_EMAILS?.trim();
  if (!raw) return null;
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length > 0 ? new Set(parts) : null;
}

function getAdminToken(): string {
  const t = process.env.ADMIN_TOKEN;
  if (!t) throw new Error('ADMIN_TOKEN env var not set');
  return t;
}

function getCookieSecret(): string {
  const s = process.env.ADMIN_COOKIE_SECRET;
  if (!s) throw new Error('ADMIN_COOKIE_SECRET env var not set');
  return s;
}

/**
 * Verify a plaintext admin token and mint a Set-Cookie header that
 * authenticates the admin for `TTL_SECONDS`.
 *
 * Single-admin model: ADMIN_TOKEN env stores the plaintext (rotation =
 * env-var update + redeploy). At this scale (one admin) hashing the env
 * value adds no real security: an attacker who can read env vars has
 * already won. We use timingSafeEqual on the comparison anyway to keep
 * the auth path uniform.
 */
export async function loginAdmin(plaintext: string): Promise<string> {
  // Belt-and-braces: never mint a long-lived cookie when the deployment
  // has explicitly delegated auth to an upstream proxy. Even if an old
  // ADMIN_TOKEN env var lingers, this path stays closed.
  if (getAuthMode() === 'proxy') {
    throw new AdminUnauthorizedError(
      'admin-token login disabled when OPS_AUTH_MODE=proxy',
    );
  }
  const expected = Buffer.from(getAdminToken());
  const provided = Buffer.from(plaintext);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    throw new AdminUnauthorizedError('invalid admin token');
  }
  return mintCookie();
}

/**
 * Resolve the operator behind the request. The active strategy depends on
 * `OPS_AUTH_MODE`:
 *
 * - `admin-token` *(default)*: legacy `__fe_admin` cookie only. Returns
 *   `{ email: 'admin', source: 'admin-token' }`.
 * - `proxy`: trust `X-Auth-User-Email` from a known-good reverse proxy
 *   (Traefik forwardAuth → cf-access-verifier). Returns the verified email.
 *   The dashboard MUST be unreachable except through that proxy.
 * - `either`: try the proxy header first, fall back to the cookie. Useful
 *   during a migration window or as a break-glass path.
 *
 * In `proxy` mode, `OPERATOR_EMAILS` (comma-separated) optionally restricts
 * which authenticated identities are accepted. Unset = anyone the proxy
 * authenticated is in.
 */
export function requireOperator(headers: Headers): OperatorIdentity {
  const mode = getAuthMode();

  if (mode === 'proxy' || mode === 'either') {
    const proxied = readProxyIdentity(headers);
    if (proxied) {
      const allow = getOperatorAllowlist();
      if (allow && !allow.has(proxied.email.toLowerCase())) {
        throw new AdminUnauthorizedError(
          `operator email not in OPERATOR_EMAILS allowlist: ${proxied.email}`,
        );
      }
      return proxied;
    }
    if (mode === 'proxy') {
      throw new AdminUnauthorizedError(
        `missing ${PROXY_EMAIL_HEADER} header (OPS_AUTH_MODE=proxy expects a trusted reverse proxy in front)`,
      );
    }
    // mode === 'either' → fall through to cookie check below
  }

  verifyAdminCookie(headers);
  return { email: 'admin', source: 'admin-token' };
}

/**
 * Backwards-compatible thin wrapper over `requireOperator`. Existing
 * callers that don't care about identity keep working with no changes.
 */
export function requireAdmin(headers: Headers): void {
  requireOperator(headers);
}

function readProxyIdentity(headers: Headers): OperatorIdentity | null {
  const email = headers.get(PROXY_EMAIL_HEADER)?.trim();
  if (!email) return null;
  return { email, source: 'cf-access' };
}

function verifyAdminCookie(headers: Headers): void {
  const cookieHeader = headers.get('cookie') ?? '';
  const value = pickCookie(cookieHeader, ADMIN_COOKIE_NAME);
  if (!value) throw new AdminUnauthorizedError('no admin cookie');

  let parsed: { exp: unknown; sig: unknown };
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw new AdminUnauthorizedError('malformed admin cookie');
  }

  if (typeof parsed.exp !== 'number' || typeof parsed.sig !== 'string') {
    throw new AdminUnauthorizedError('malformed admin cookie');
  }
  if (parsed.exp < Date.now()) {
    throw new AdminUnauthorizedError('admin cookie expired');
  }

  const expectedSig = signExp(parsed.exp);
  const actualBuf = Buffer.from(parsed.sig, 'base64url');
  const expectedBuf = Buffer.from(expectedSig, 'base64url');
  if (
    actualBuf.length !== expectedBuf.length ||
    !timingSafeEqual(actualBuf, expectedBuf)
  ) {
    throw new AdminUnauthorizedError('admin cookie signature mismatch');
  }
}

function mintCookie(): string {
  const exp = Date.now() + TTL_SECONDS * 1000;
  const sig = signExp(exp);
  const value = Buffer.from(JSON.stringify({ exp, sig })).toString('base64');
  return [
    `${ADMIN_COOKIE_NAME}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${TTL_SECONDS}`,
    'Secure',
  ].join('; ');
}

function signExp(exp: number): string {
  return createHmac('sha256', getCookieSecret())
    .update(String(exp))
    .digest('base64url');
}

function pickCookie(cookieHeader: string, name: string): string | null {
  // Cookies are `k=v; k=v` with optional whitespace around the separators.
  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1);
    }
  }
  return null;
}
