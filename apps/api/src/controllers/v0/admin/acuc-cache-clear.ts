import { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { clearACUC, clearACUCTeam } from "../../auth";
import { logger } from "../../../lib/logger";

export async function acucCacheClearController(req: Request, res: Response) {
  try {
    const team_id: string = req.body.team_id;

    if (!team_id) {
      return res.status(400).json({ error: "team_id is required" });
    }

    const keys = await db
      .select()
      .from(schema.api_keys)
      .where(eq(schema.api_keys.team_id, team_id));

    await Promise.all(keys.map(x => clearACUC(x.key!)));
    await clearACUCTeam(team_id);

    logger.info(`ACUC cache cleared for team ${team_id}`);
    res.json({ ok: true });
  } catch (error) {
    logger.error(`Error clearing ACUC cache via API route: ${error}`);
    res.status(500).json({ error: "Internal server error" });
  }
}
