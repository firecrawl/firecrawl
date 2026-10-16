import { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { clearACUC, clearACUCTeam } from "../../auth";
import { logger } from "../../../lib/logger";

// api_keys lists keys the caller just deleted, which the team lookup below
// can no longer find.
const acucCacheClearSchema = z.object({
  team_id: z.string().min(1),
  api_keys: z
    .array(
      z.object({
        id: z.number().int().positive(),
        key_hash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
      }),
    )
    .optional(),
});

export async function acucCacheClearController(req: Request, res: Response) {
  try {
    const body = acucCacheClearSchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        error: "Expected { team_id, api_keys?: { id, key_hash }[] }",
      });
    }
    const { team_id, api_keys = [] } = body.data;

    const teamKeys = await db
      .select({ id: schema.api_keys.id, key_hash: schema.api_keys.key_hash })
      .from(schema.api_keys)
      .where(eq(schema.api_keys.team_id, team_id));

    await clearACUC([...api_keys, ...teamKeys]);
    await clearACUCTeam(team_id);

    logger.info(`ACUC cache cleared for team ${team_id}`);
    res.json({ ok: true });
  } catch (error) {
    logger.error(`Error clearing ACUC cache via API route: ${error}`);
    res.status(500).json({ error: "Internal server error" });
  }
}
