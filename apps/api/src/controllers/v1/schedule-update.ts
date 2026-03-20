import { Response } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import * as Sentry from "@sentry/node";
import { RequestWithAuth } from "./types";
import { supabase_service } from "../../services/supabase";
import { getSchedulerQueue } from "../../services/queue-service";

const scheduleUpdateSchema = z.object({
  cron: z.string().min(1).optional(),
  paused: z.boolean().optional(),
  name: z.string().max(255).optional(),
});

type ScheduleUpdateRequest = z.infer<typeof scheduleUpdateSchema>;

type ScheduleUpdateResponse =
  | { success: true; schedule: any }
  | { success: false; error: string };

export async function scheduleUpdateController(
  req: RequestWithAuth<
    { scheduleId: string },
    ScheduleUpdateResponse,
    ScheduleUpdateRequest
  >,
  res: Response<ScheduleUpdateResponse>,
) {
  try {
    const body = scheduleUpdateSchema.parse(req.body);

    const { data: existing, error: fetchError } = await supabase_service
      .from("schedules")
      .select("*")
      .eq("id", req.params.scheduleId)
      .eq("team_id", req.auth.team_id)
      .single();

    if (fetchError || !existing) {
      return res
        .status(404)
        .json({ success: false, error: "Schedule not found" });
    }

    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };
    if (body.cron !== undefined) updates.cron = body.cron;
    if (body.paused !== undefined) updates.paused = body.paused;
    if (body.name !== undefined) updates.name = body.name;

    const { data: updated, error: updateError } = await supabase_service
      .from("schedules")
      .update(updates)
      .eq("id", req.params.scheduleId)
      .select()
      .single();

    if (updateError) {
      logger.error("Failed to update schedule", {
        error: updateError,
        scheduleId: req.params.scheduleId,
      });
      return res
        .status(500)
        .json({ success: false, error: "Failed to update schedule" });
    }

    // If cron changed, re-register the repeatable job
    if (body.cron !== undefined) {
      const queue = getSchedulerQueue();
      await queue.removeRepeatableByKey(`schedule:${req.params.scheduleId}`);
      if (!body.paused && !existing.paused) {
        await queue.add(
          "scheduled-run",
          { scheduleId: req.params.scheduleId },
          {
            repeat: { pattern: body.cron },
            jobId: `schedule:${req.params.scheduleId}`,
          },
        );
      }
    }

    return res.json({ success: true, schedule: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res
        .status(400)
        .json({
          success: false,
          error: error.issues.map((e: any) => e.message).join(", "),
        });
    }
    Sentry.captureException(error);
    logger.error("scheduleUpdateController error", { error });
    return res.status(500).json({ success: false, error: error.message });
  }
}
