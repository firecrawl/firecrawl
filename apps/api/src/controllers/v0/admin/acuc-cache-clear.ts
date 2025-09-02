import { Request, Response } from "express";
import { supabase_service } from "../../../services/supabase";
import { clearACUC, clearACUCTeam } from "../../auth";
import { logger } from "../../../lib/logger";

export async function acucCacheClearController(req: Request, res: Response) {
  try {
    const team_id: string = req.body.team_id;

    const keys = await supabase_service
      .from("api_keys")
      .select("*")
      .eq("team_id", team_id);

    await Promise.all((keys.data ?? []).map(x => clearACUC(x.key)));
    await clearACUCTeam(team_id);

    logger.info(`ACUC cache cleared for team ${team_id}`);
    res.json({ ok: true });
  } catch (error) {
    logger.error(`Error clearing ACUC cache via API route: ${error}`);
    res.status(500).json({ error: "Internal server error" });
  }
}
