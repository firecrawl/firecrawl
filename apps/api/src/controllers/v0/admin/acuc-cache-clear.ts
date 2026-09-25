import { Request, Response } from "express";
import { clearACUCForTeam } from "../../auth";
import { logger } from "../../../lib/logger";

export async function acucCacheClearController(req: Request, res: Response) {
  try {
    const team_id: string = req.body.team_id;

    if (!team_id) {
      return res.status(400).json({ error: "team_id is required" });
    }

    await clearACUCForTeam(team_id);

    logger.info(`ACUC cache cleared for team ${team_id}`);
    res.json({ ok: true });
  } catch (error) {
    logger.error(`Error clearing ACUC cache via API route: ${error}`);
    res.status(500).json({ error: "Internal server error" });
  }
}
