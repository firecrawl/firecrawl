import { z, ZodError } from 'zod';

import {
  AdminUnauthorizedError,
  requireAdmin,
} from '@fire-enrich/core/server';
import {
  createPrincipal,
  getDb,
  listPrincipals,
} from '@fire-enrich/db';

import { toPrincipalSummary } from '@/lib/admin-types';

const QuotaSchema = z
  .object({ limit: z.number().int().positive() })
  .nullable()
  .optional();

function normalizeQuota(
  q: { limit?: number } | null | undefined,
): { limit: number } | null {
  if (!q || typeof q.limit !== 'number') return null;
  return { limit: q.limit };
}

const CreateBody = z.object({
  label: z.string().min(1),
  byokFirecrawlKey: z.string().min(1).optional(),
  byokOpenaiKey: z.string().min(1).optional(),
  quotaFirecrawlMonth: QuotaSchema,
  quotaOpenaiMonth: QuotaSchema,
});

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

export async function GET(req: Request): Promise<Response> {
  const denied = adminGuard(req);
  if (denied) return denied;

  const db = getDb();
  const rows = await listPrincipals(db);
  return Response.json({
    principals: rows.map(toPrincipalSummary),
  });
}

export async function POST(req: Request): Promise<Response> {
  const denied = adminGuard(req);
  if (denied) return denied;

  let body: z.infer<typeof CreateBody>;
  try {
    const json = await req.json();
    body = CreateBody.parse(json);
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
  const { principal, plaintextToken } = await createPrincipal(
    {
      label: body.label,
      byokFirecrawlKey: body.byokFirecrawlKey,
      byokOpenaiKey: body.byokOpenaiKey,
      quotaFirecrawlMonth: normalizeQuota(body.quotaFirecrawlMonth),
      quotaOpenaiMonth: normalizeQuota(body.quotaOpenaiMonth),
    },
    db,
  );

  return Response.json({
    principal: toPrincipalSummary(principal),
    plaintextToken,
  });
}
