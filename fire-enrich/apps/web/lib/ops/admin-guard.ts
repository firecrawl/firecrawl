// apps/web/lib/ops/admin-guard.ts
// One-line admin gate to keep every /api/admin/ops/** route consistent.

import {
  AdminUnauthorizedError,
  requireAdmin,
} from '@fire-enrich/core/server';

export function adminGuard(req: Request): Response | null {
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
