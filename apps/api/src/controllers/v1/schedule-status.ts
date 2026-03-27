import { Response } from "express";
import { logger } from "../../lib/logger";
import * as Sentry from "@sentry/node";
import { RequestWithAuth } from "./types";
import { supabase_service } from "../../services/supabase";

type ScheduleStatusResponse =
  | { success: true; schedule: any }
  | { success: false; error: string };

export async function scheduleStatusController(
  req: RequestWithAuth<{ scheduleId: string }, ScheduleStatusResponse, {}>,
  res: Response<ScheduleStatusResponse>,
) {
  try {
    const { data, error } = await supabase_service
      .from("schedules")
      .select("*")
      .eq("id", req.params.scheduleId)
      .eq("team_id", req.auth.team_id)
      .single();

    if (error || !data) {
      return res
        .status(404)
        .json({ success: false, error: "Schedule not found" });
    }

    return res.json({ success: true, schedule: data });
  } catch (error) {
    Sentry.captureException(error);
    logger.error("scheduleStatusController error", { error });
    return res.status(500).json({ success: false, error: error.message });
  }
}
