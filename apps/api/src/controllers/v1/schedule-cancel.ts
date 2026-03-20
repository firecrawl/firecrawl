import { Response } from "express";
import { logger } from "../../lib/logger";
import * as Sentry from "@sentry/node";
import { RequestWithAuth } from "./types";
import { supabase_service } from "../../services/supabase";
import { getSchedulerQueue } from "../../services/queue-service";

type ScheduleCancelResponse =
  | { success: true }
  | { success: false; error: string };

export async function scheduleCancelController(
  req: RequestWithAuth<{ scheduleId: string }, ScheduleCancelResponse, {}>,
  res: Response<ScheduleCancelResponse>,
) {
  try {
    const { data, error } = await supabase_service
      .from("schedules")
      .select("id, team_id")
      .eq("id", req.params.scheduleId)
      .eq("team_id", req.auth.team_id)
      .single();

    if (error || !data) {
      return res
        .status(404)
        .json({ success: false, error: "Schedule not found" });
    }

    // Remove the repeatable job from BullMQ
    const queue = getSchedulerQueue();
    await queue.removeRepeatableByKey(`schedule:${req.params.scheduleId}`);

    // Delete from Supabase
    const { error: delError } = await supabase_service
      .from("schedules")
      .delete()
      .eq("id", req.params.scheduleId);

    if (delError) {
      logger.error("Failed to delete schedule", {
        error: delError,
        scheduleId: req.params.scheduleId,
      });
      return res
        .status(500)
        .json({ success: false, error: "Failed to delete schedule" });
    }

    return res.json({ success: true });
  } catch (error) {
    Sentry.captureException(error);
    logger.error("scheduleCancelController error", { error });
    return res.status(500).json({ success: false, error: error.message });
  }
}
