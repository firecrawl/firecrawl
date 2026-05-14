import {
  AdminUnauthorizedError,
  requireAdmin,
} from '@fire-enrich/core/server';
import { getDb, revokePrincipal } from '@fire-enrich/db';

import { toPrincipalSummary } from '@/lib/admin-types';

type RouteContext = { params: Promise<{ id: string }> };

function adminGuard(req: Request): Response | null {
  try {
    requireAdmin(req.headers);
    return null;
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

export async function DELETE(req: Request, ctx: RouteContext): Promise<Response> {
  const denied = adminGuard(req);
  if (denied) return denied;

  const { id } = await ctx.params;
  if (!id) {
    return Response.json(
      { code: 'invalid_request', error: 'missing id' },
      { status: 400 },
    );
  }

  const db = getDb();
  const revoked = await revokePrincipal(id, db);
  if (!revoked) {
    return Response.json(
      { code: 'not_found', error: `principal ${id} not found` },
      { status: 404 },
    );
  }

  return Response.json({ revoked: toPrincipalSummary(revoked) });
}
