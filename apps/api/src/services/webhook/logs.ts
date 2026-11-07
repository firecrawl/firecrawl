import { and, desc, eq, inArray } from "drizzle-orm";
import { dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { logger as _logger } from "../../lib/logger";

export type WebhookLogRow = {
  id: string;
  success: boolean;
  error: string | null;
  status_code: number | null;
  latency_ms: number | null;
  url: string;
  event: string;
  created_at: string;
};

export async function getLatestWebhookLog(params: {
  jobId: string;
  event: string;
}): Promise<WebhookLogRow | null> {
  try {
    const [data] = await dbRr
      .select({
        id: schema.webhook_logs.id,
        success: schema.webhook_logs.success,
        error: schema.webhook_logs.error,
        status_code: schema.webhook_logs.status_code,
        latency_ms: schema.webhook_logs.latency_ms,
        url: schema.webhook_logs.url,
        event: schema.webhook_logs.event,
        created_at: schema.webhook_logs.created_at,
      })
      .from(schema.webhook_logs)
      .where(
        and(
          eq(schema.webhook_logs.crawl_id, params.jobId),
          eq(schema.webhook_logs.event, params.event),
        ),
      )
      .orderBy(desc(schema.webhook_logs.created_at))
      .limit(1);
    return (data ?? null) as WebhookLogRow | null;
  } catch (error) {
    _logger.warn("Failed to fetch latest webhook log", {
      module: "webhook-logs",
      jobId: params.jobId,
      event: params.event,
      error,
    });
    return null;
  }
}

export async function getLatestWebhookLogsByJob(params: {
  jobIds: string[];
  event: string;
}): Promise<Map<string, WebhookLogRow>> {
  const result = new Map<string, WebhookLogRow>();
  if (params.jobIds.length === 0) return result;

  let data: (WebhookLogRow & { crawl_id: string })[];
  try {
    data = await dbRr
      .select({
        id: schema.webhook_logs.id,
        success: schema.webhook_logs.success,
        error: schema.webhook_logs.error,
        status_code: schema.webhook_logs.status_code,
        latency_ms: schema.webhook_logs.latency_ms,
        url: schema.webhook_logs.url,
        event: schema.webhook_logs.event,
        created_at: schema.webhook_logs.created_at,
        crawl_id: schema.webhook_logs.crawl_id,
      })
      .from(schema.webhook_logs)
      .where(
        and(
          inArray(schema.webhook_logs.crawl_id, params.jobIds),
          eq(schema.webhook_logs.event, params.event),
        ),
      )
      .orderBy(desc(schema.webhook_logs.created_at));
  } catch (error) {
    _logger.warn("Failed to fetch webhook logs batch", {
      module: "webhook-logs",
      event: params.event,
      error,
    });
    return result;
  }

  for (const row of data) {
    if (!result.has(row.crawl_id)) result.set(row.crawl_id, row);
  }
  return result;
}
