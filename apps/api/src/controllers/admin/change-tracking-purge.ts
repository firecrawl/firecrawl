import { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import {
  changeTrackingPurgeConfigured,
  enqueueChangeTrackingPurge,
} from "../../services/change-tracking-purge";

const bodySchema = z.object({ team_id: z.guid() });

// Called by the dashboard before it deletes a team. Only `queued: true` means
// the purge is durably scheduled; an error must stop the deletion.
export async function changeTrackingPurgeController(
  req: Request,
  res: Response,
) {
  const body = bodySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "team_id must be a team UUID" });
  }
  const teamId = body.data.team_id.toLowerCase();

  if (!changeTrackingPurgeConfigured()) {
    return res.status(200).json({ ok: true, queued: false });
  }

  try {
    await enqueueChangeTrackingPurge(teamId);
  } catch (error) {
    logger.error("Failed to schedule the change tracking purge", {
      teamId,
      error,
    });
    return res.status(500).json({ error: "Internal server error" });
  }

  logger.info("Change tracking purge scheduled", { teamId });
  return res.status(202).json({ ok: true, queued: true });
}
