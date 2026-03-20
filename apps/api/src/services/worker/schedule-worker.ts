import "dotenv/config";
import { configDotenv } from "dotenv";
import { Worker } from "bullmq";
import * as Sentry from "@sentry/node";
import { logger as _logger } from "../../lib/logger";
import {
  getSchedulerQueue,
  schedulerQueueName,
  SchedulerJobData,
  getRedisConnection,
} from "../queue-service";
import { supabase_service } from "../supabase";
import { addScrapeJob } from "../queue-jobs";
import { createWebhookSender, WebhookEvent } from "../webhook/index";
import { v7 as uuidv7 } from "uuid";
import { fromV1ScrapeOptions } from "../../controllers/v2/types";

configDotenv();

const logger = _logger.child({ module: "schedule-worker" });

async function processScheduleJob(data: SchedulerJobData): Promise<void> {
  const { scheduleId } = data;
  const jobLogger = logger.child({ scheduleId });

  const { data: schedule, error: fetchError } = await supabase_service
    .from("schedules")
    .select("*")
    .eq("id", scheduleId)
    .single();

  if (fetchError || !schedule) {
    jobLogger.warn("Schedule not found, skipping", { fetchError });
    return;
  }

  if (schedule.paused) {
    jobLogger.info("Schedule is paused, skipping");
    return;
  }

  const teamId: string = schedule.team_id;
  const jobId = uuidv7();

  const sender = await createWebhookSender({
    teamId,
    jobId,
    webhook: schedule.webhook ?? undefined,
    v0: false,
  });

  try {
    if (schedule.mode === "scrape") {
      const scrapeOptions = schedule.scrape_options ?? {};
      const { scrapeOptions: parsedOptions } = fromV1ScrapeOptions(
        scrapeOptions,
        undefined,
        teamId,
      );
      await addScrapeJob(
        {
          mode: "single_urls",
          url: schedule.url,
          scrapeOptions: parsedOptions,
          origin: "schedule",
          team_id: teamId,
          zeroDataRetention: false,
          webhook: schedule.webhook ?? undefined,
          v1: true,
          is_scrape: true,
          apiKeyId: null,
        },
        jobId,
        0,
        false,
        false,
      );
    } else {
      // crawl mode — dispatch as a scrape for v1; full crawl support is a future enhancement
      jobLogger.warn(
        "Crawl mode scheduling not yet implemented, treating as scrape",
      );
      const { scrapeOptions: parsedOptions } = fromV1ScrapeOptions(
        schedule.scrape_options ?? {},
        undefined,
        teamId,
      );
      await addScrapeJob(
        {
          mode: "single_urls",
          url: schedule.url,
          scrapeOptions: parsedOptions,
          origin: "schedule",
          team_id: teamId,
          zeroDataRetention: false,
          webhook: schedule.webhook ?? undefined,
          v1: true,
          is_scrape: true,
          apiKeyId: null,
        },
        jobId,
        0,
        false,
        false,
      );
    }

    await supabase_service
      .from("schedules")
      .update({
        last_run_at: new Date().toISOString(),
        last_run_status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", scheduleId);

    if (sender) {
      await sender.send(WebhookEvent.SCHEDULE_COMPLETED, {
        success: true,
        scheduleId,
        data: [],
      });
    }

    jobLogger.info("Schedule run dispatched", { jobId });
  } catch (error) {
    Sentry.captureException(error);
    jobLogger.error("Schedule run failed", { error });

    await supabase_service
      .from("schedules")
      .update({
        last_run_at: new Date().toISOString(),
        last_run_status: "failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", scheduleId);

    if (sender) {
      await sender.send(WebhookEvent.SCHEDULE_FAILED, {
        success: false,
        scheduleId,
        error: error?.message ?? "Unknown error",
      });
    }
  }
}

export function startScheduleWorker() {
  const worker = new Worker<SchedulerJobData>(
    schedulerQueueName,
    async job => {
      await processScheduleJob(job.data);
    },
    {
      connection: getRedisConnection(),
      concurrency: 10,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error("Schedule worker job failed", { jobId: job?.id, err });
    Sentry.captureException(err);
  });

  worker.on("error", err => {
    logger.error("Schedule worker error", { err });
    Sentry.captureException(err);
  });

  logger.info("Schedule worker started");
  return worker;
}
