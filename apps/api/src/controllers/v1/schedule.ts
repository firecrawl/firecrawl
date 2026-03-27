import { Response } from "express";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import { logger } from "../../lib/logger";
import * as Sentry from "@sentry/node";
import {
  RequestWithAuth,
  scrapeRequestSchema,
  crawlRequestSchema,
} from "./types";
import { webhookSchema } from "../../services/webhook/schema";
import { getSchedulerQueue } from "../../services/queue-service";
import { supabase_service } from "../../services/supabase";

const scheduleCreateSchema = z.object({
  name: z.string().max(255).optional(),
  cron: z.string().min(1),
  url: z.string().url(),
  mode: z.enum(["scrape", "crawl"]).default("scrape"),
  scrapeOptions: scrapeRequestSchema.optional(),
  crawlOptions: crawlRequestSchema.optional(),
  webhook: webhookSchema.optional(),
});

type ScheduleCreateRequest = z.infer<typeof scheduleCreateSchema>;

type ScheduleCreateResponse =
  | { success: true; id: string; nextRunAt: string | null }
  | { success: false; error: string };

export async function scheduleCreateController(
  req: RequestWithAuth<{}, ScheduleCreateResponse, ScheduleCreateRequest>,
  res: Response<ScheduleCreateResponse>,
) {
  try {
    const body = scheduleCreateSchema.parse(req.body);

    const id = uuidv7();

    const { error } = await supabase_service.from("schedules").insert({
      id,
      team_id: req.auth.team_id,
      name: body.name ?? null,
      cron: body.cron,
      url: body.url,
      mode: body.mode,
      scrape_options: body.scrapeOptions ?? null,
      crawl_options: body.crawlOptions ?? null,
      webhook: body.webhook ?? null,
      paused: false,
    });

    if (error) {
      logger.error("Failed to insert schedule", {
        error,
        teamId: req.auth.team_id,
      });
      return res
        .status(500)
        .json({ success: false, error: "Failed to create schedule" });
    }

    // Register the repeatable job in BullMQ
    const queue = getSchedulerQueue();
    await queue.add(
      "scheduled-run",
      { scheduleId: id },
      {
        repeat: { pattern: body.cron },
        jobId: `schedule:${id}`,
      },
    );

    return res.status(201).json({ success: true, id, nextRunAt: null });
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
    logger.error("scheduleCreateController error", { error });
    return res.status(500).json({ success: false, error: error.message });
  }
}
