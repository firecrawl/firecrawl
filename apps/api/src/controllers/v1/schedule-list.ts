import { Response } from "express";
import { logger } from "../../lib/logger";
import * as Sentry from "@sentry/node";
import { RequestWithAuth } from "./types";
import { supabase_service } from "../../services/supabase";

type ScheduleListResponse =
  | { success: true; schedules: any[] }
  | { success: false; error: string };

export async function scheduleListController(
  req: RequestWithAuth<{}, ScheduleListResponse, {}>,
  res: Response<ScheduleListResponse>,
) {
  try {
    const { data, error } = await supabase_service
      .from("schedules")
      .select("*")
      .eq("team_id", req.auth.team_id)
      .order("created_at", { ascending: false });

    if (error) {
      logger.error("Failed to list schedules", {
        error,
        teamId: req.auth.team_id,
      });
      return res
        .status(500)
        .json({ success: false, error: "Failed to list schedules" });
    }

    return res.json({ success: true, schedules: data ?? [] });
  } catch (error) {
    Sentry.captureException(error);
    logger.error("scheduleListController error", { error });
    return res.status(500).json({ success: false, error: error.message });
  }
}
