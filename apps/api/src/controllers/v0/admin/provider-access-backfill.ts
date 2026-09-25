import { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../../../lib/logger";
import { backfillProviderAccess } from "../../../services/alexandria/access-backfill";

const bodySchema = z.strictObject({
  orgIds: z.array(z.uuid()).min(1).max(100),
  // Writes only when a caller says so explicitly.
  dryRun: z.boolean().default(true),
});

/**
 * One-off backfill of organization_data_source_access from Exchange ledger
 * acceptances. See services/alexandria/access-backfill.ts. Dry run unless the
 * body sets `dryRun: false`.
 */
export async function providerAccessBackfillController(
  req: Request,
  res: Response,
) {
  const body = bodySchema.safeParse(req.body ?? {});
  if (!body.success)
    return res.status(400).json({
      error:
        "Send { orgIds: [uuid, ...] (1-100), dryRun?: boolean (default true) }.",
    });
  const { dryRun, results } = await backfillProviderAccess(body.data);
  const counts: Record<string, number> = {};
  for (const result of results)
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  logger.info("Provider access backfill finished", {
    module: "provider-access-backfill",
    dryRun,
    orgs: body.data.orgIds.length,
    counts,
  });
  return res.json({ ok: true, dryRun, counts, results });
}
