import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge-runtime shape gate.
 *
 * Runs in the Edge runtime (no `pg`, no `node:crypto.scrypt`), so this
 * file ONLY does cheap presence/format checks and short-circuits with a
 * 401 when they fail. The HMAC / DB / signature work happens in the
 * Node-runtime route handlers via `requireBearer` / `requireOperator`.
 *
 *   /api/firecrawl/* — must carry `Authorization: Bearer fe_...`.
 *   /admin/*         — gated per OPS_AUTH_MODE:
 *                        admin-token (default) — `__fe_admin` cookie
 *                        proxy                 — `X-Auth-User-Email` header
 *                        either                — header OR cookie
 *
 * Anything else falls through untouched.
 */

type AuthMode = 'admin-token' | 'proxy' | 'either';

const PROXY_EMAIL_HEADER = 'x-auth-user-email';

function authMode(): AuthMode {
  const raw = (process.env.OPS_AUTH_MODE ?? 'admin-token').trim().toLowerCase();
  return raw === 'proxy' || raw === 'either' ? raw : 'admin-token';
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith('/api/firecrawl/')) {
    const auth = req.headers.get('authorization') ?? '';
    if (!/^Bearer\s+fe_\S+$/i.test(auth)) {
      return NextResponse.json(
        { code: 'unauthorized', error: 'missing or malformed bearer token' },
        { status: 401 },
      );
    }
    return NextResponse.next();
  }

  if (pathname.startsWith('/admin/')) {
    const mode = authMode();

    // Login page never requires the cookie. In proxy mode it should not
    // be reachable at all — return 410 so a misconfigured client gets a
    // clear signal rather than a working-but-bypassed login form.
    if (pathname === '/admin/login' || pathname.startsWith('/admin/login/')) {
      if (mode === 'proxy') {
        return new NextResponse(
          'Admin login disabled: OPS_AUTH_MODE=proxy delegates to the upstream IDP.',
          { status: 410, headers: { 'content-type': 'text/plain' } },
        );
      }
      return NextResponse.next();
    }

    if (mode === 'proxy' || mode === 'either') {
      const email = req.headers.get(PROXY_EMAIL_HEADER);
      if (email && email.trim().length > 0) {
        return NextResponse.next();
      }
      if (mode === 'proxy') {
        // Header missing in proxy mode is a 403, not a redirect — there
        // is nowhere to redirect TO. The proxy is supposed to add the
        // header upstream; if it didn't, this request bypassed it.
        return new NextResponse(
          'Forbidden: missing X-Auth-User-Email proxy header.',
          { status: 403, headers: { 'content-type': 'text/plain' } },
        );
      }
      // mode === 'either' → fall through to cookie check
    }

    const cookie = req.cookies.get('__fe_admin');
    if (!cookie?.value) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = '/admin/login';
      loginUrl.search = '';
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/firecrawl/:path*', '/admin/:path*'],
};
