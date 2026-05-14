import {
  AdminUnauthorizedError,
  loginAdmin,
} from '@fire-enrich/core/server';

/**
 * POST /api/admin/login
 *
 * Body: { token: string }
 *
 * On success: 200 with `Set-Cookie: __fe_admin=...` header (HMAC-stamped,
 * minted by `loginAdmin`). On invalid token: 401 with a structured error.
 *
 * NOTE: middleware's matcher is `/admin/:path*`, NOT `/api/admin/:path*`,
 * so this route is not gated by the cookie — which is correct, because
 * you need to log in before you have a cookie.
 */
export async function POST(req: Request): Promise<Response> {
  let token: unknown;
  try {
    const body = (await req.json()) as { token?: unknown };
    token = body?.token;
  } catch {
    return Response.json(
      { code: 'invalid_request', error: 'invalid JSON body' },
      { status: 400 },
    );
  }

  if (typeof token !== 'string' || token.length === 0) {
    return Response.json(
      { code: 'invalid_request', error: 'token must be a non-empty string' },
      { status: 400 },
    );
  }

  try {
    const setCookie = await loginAdmin(token);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': setCookie,
      },
    });
  } catch (err) {
    if (err instanceof AdminUnauthorizedError) {
      return Response.json(
        { code: err.code, error: err.message },
        { status: 401 },
      );
    }
    throw err;
  }
}
