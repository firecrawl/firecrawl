import { z } from "zod";
import {
  crawlerOptions,
  URL as urlSchema,
  type ScrapeOptions,
} from "../../controllers/v2/types";
import { createWebhookSchema } from "../webhook/schema";
import { parseMonitorScheduleText } from "./cron";

const formatSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

const scrapeOptionsSchema = z
  .object({
    formats: z.array(formatSchema).optional(),
  })
  .catchall(z.unknown())
  .optional()
  .default({});

const scrapeTargetSchema = z.strictObject({
  id: z.string().uuid().optional(),
  type: z.literal("scrape"),
  urls: z.array(urlSchema).min(1),
  scrapeOptions: scrapeOptionsSchema,
});

const crawlTargetSchema = z.strictObject({
  id: z.string().uuid().optional(),
  type: z.literal("crawl"),
  url: urlSchema,
  crawlOptions: crawlerOptions
    .partial()
    .catchall(z.unknown())
    .optional()
    .default({}),
  scrapeOptions: scrapeOptionsSchema,
});

const monitorTargetSchema = z.union([scrapeTargetSchema, crawlTargetSchema]);

const monitorWebhookSchema = createWebhookSchema([
  "monitor.page",
  "monitor.check.completed",
]);

const monitorScheduleSchema = z
  .strictObject({
    cron: z.string().min(1).max(128).optional(),
    text: z.string().min(1).max(128).optional(),
    timezone: z.string().min(1).max(128).optional().default("UTC"),
  })
  .superRefine((schedule, ctx) => {
    if (!schedule.cron && !schedule.text) {
      ctx.addIssue({
        code: "custom",
        message: "Schedule must include either cron or text",
        path: ["cron"],
      });
    }
    if (schedule.cron && schedule.text) {
      ctx.addIssue({
        code: "custom",
        message: "Schedule must include either cron or text, not both",
        path: ["text"],
      });
    }
    if (schedule.text) {
      try {
        parseMonitorScheduleText(schedule.text);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
          path: ["text"],
        });
      }
    }
  })
  .transform(schedule => ({
    cron: schedule.cron ?? parseMonitorScheduleText(schedule.text!),
    timezone: schedule.timezone,
  }));

const monitorNotificationSchema = z
  .strictObject({
    email: z
      .strictObject({
        enabled: z.boolean().optional().default(false),
        recipients: z.array(z.email()).max(25).optional().default([]),
        includeDiffs: z.boolean().optional().default(false),
      })
      .optional(),
  })
  .optional()
  .default({});

export const createMonitorSchema = z.strictObject({
  name: z.string().min(1).max(256),
  schedule: monitorScheduleSchema,
  webhook: monitorWebhookSchema.optional(),
  notification: monitorNotificationSchema,
  targets: z.array(monitorTargetSchema).min(1).max(50),
  retentionDays: z.number().int().positive().max(365).optional().default(30),
});

export const updateMonitorSchema = createMonitorSchema
  .partial()
  .extend({
    status: z.enum(["active", "paused"]).optional(),
  })
  .refine(x => Object.keys(x).length > 0, "Update body cannot be empty");

export const listMonitorsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(25),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

export const listMonitorChecksQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(25),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  status: z
    .enum([
      "queued",
      "running",
      "completed",
      "failed",
      "partial",
      "skipped_overlap",
    ])
    .optional(),
});

export const monitorCheckDetailQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(25),
  skip: z.coerce.number().int().nonnegative().optional().default(0),
  status: z.enum(["same", "new", "changed", "removed", "error"]).optional(),
});

export type MonitorTarget = z.infer<typeof monitorTargetSchema> & {
  id: string;
};
export type CreateMonitorRequest = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorRequest = z.infer<typeof updateMonitorSchema>;
type MonitorNotification = z.infer<typeof monitorNotificationSchema>;

export type MonitorRow = {
  id: string;
  team_id: string;
  name: string;
  status: "active" | "paused" | "deleted";
  schedule_cron: string;
  schedule_timezone: string;
  next_run_at: string | null;
  last_run_at: string | null;
  current_check_id: string | null;
  locked_at: string | null;
  locked_until: string | null;
  retention_days: number;
  estimated_credits_per_month: number | null;
  targets: MonitorTarget[];
  webhook: unknown | null;
  notification: MonitorNotification | null;
  last_check_summary: MonitorSummary | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type MonitorCheckRow = {
  id: string;
  monitor_id: string;
  team_id: string;
  trigger: "scheduled" | "manual";
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "partial"
    | "skipped_overlap";
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  estimated_credits: number | null;
  reserved_credits: number | null;
  actual_credits: number | null;
  autumn_lock_id: string | null;
  billing_status:
    | "not_applicable"
    | "reserved"
    | "confirmed"
    | "released"
    | "failed";
  total_pages: number;
  same_count: number;
  changed_count: number;
  new_count: number;
  removed_count: number;
  error_count: number;
  target_results: unknown | null;
  webhook_payload: unknown | null;
  email_payload: unknown | null;
  notification_status: unknown | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type MonitorPageStatus = "same" | "new" | "changed" | "removed" | "error";
type MonitorPageSource = "explicit" | "discovered";

export type MonitorPageRow = {
  id: string;
  monitor_id: string;
  team_id: string;
  target_id: string;
  url: string;
  url_hash: string;
  source: MonitorPageSource;
  first_seen_check_id: string | null;
  last_seen_check_id: string | null;
  last_changed_check_id: string | null;
  last_scrape_id: string | null;
  last_status: MonitorPageStatus;
  is_removed: boolean;
  removed_at: string | null;
  metadata: unknown | null;
  created_at: string;
  updated_at: string;
};

export type MonitorSummary = {
  totalPages: number;
  same: number;
  changed: number;
  new: number;
  removed: number;
  error: number;
};

export type MonitorCheckPageInsert = {
  check_id: string;
  monitor_id: string;
  team_id: string;
  target_id: string;
  url: string;
  url_hash?: string;
  status: MonitorPageStatus;
  previous_scrape_id?: string | null;
  current_scrape_id?: string | null;
  diff_gcs_key?: string | null;
  diff_text_bytes?: number | null;
  diff_json_bytes?: number | null;
  status_code?: number | null;
  error?: string | null;
  metadata?: unknown | null;
};

export function withMarkdownFormat(
  options: Record<string, unknown>,
): ScrapeOptions {
  const formats = Array.isArray(options.formats) ? options.formats : [];
  const hasMarkdown = formats.some(format =>
    typeof format === "string"
      ? format === "markdown"
      : typeof format === "object" &&
        format !== null &&
        (format as any).type === "markdown",
  );

  return {
    ...options,
    formats: hasMarkdown ? formats : ["markdown", ...formats],
  } as ScrapeOptions;
}
