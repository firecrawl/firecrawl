import { Request, Response } from "express";
import { clearKeyRestrictionCache } from "../../../lib/key-restriction";
import { logger } from "../../../lib/logger";

// Called by the dashboard after it writes key_restriction_config so
// restriction edits take effect immediately instead of after the 60s
// cache TTL.
export async function keyRestrictionCacheClearController(
  req: Request,
  res: Response,
) {
  try {
    const api_key_id = req.body?.api_key_id;

    if (typeof api_key_id !== "number" || !Number.isInteger(api_key_id)) {
      return res.status(400).json({ error: "api_key_id is required" });
    }

    await clearKeyRestrictionCache(api_key_id);

    logger.info("Key restriction config cache cleared", { api_key_id });
    res.json({ ok: true });
  } catch (error) {
    logger.error("Error clearing key restriction cache via API route", {
      error,
    });
    res.status(500).json({ error: "Internal server error" });
  }
}
