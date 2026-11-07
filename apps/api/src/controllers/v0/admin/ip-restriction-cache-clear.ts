import { Request, Response } from "express";
import { clearIpRestrictionCache } from "../../../lib/ip-restriction";
import { logger } from "../../../lib/logger";

// Called by the dashboard after it writes ip_restriction_config so allowlist
// edits take effect immediately instead of after the 60s cache TTL.
export async function ipRestrictionCacheClearController(
  req: Request,
  res: Response,
) {
  try {
    const team_id = req.body?.team_id;

    if (typeof team_id !== "string" || team_id.length === 0) {
      return res.status(400).json({ error: "team_id is required" });
    }

    await clearIpRestrictionCache(team_id);

    logger.info("IP restriction allowlist cache cleared", { team_id });
    res.json({ ok: true });
  } catch (error) {
    logger.error("Error clearing IP restriction cache via API route", {
      error,
    });
    res.status(500).json({ error: "Internal server error" });
  }
}
