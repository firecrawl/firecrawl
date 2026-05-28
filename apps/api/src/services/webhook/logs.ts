import { supabase_rr_service } from "../supabase";
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
  const { data, error } = await supabase_rr_service
    .from("webhook_logs")
    .select("id,success,error,status_code,latency_ms,url,event,created_at")
    .eq("crawl_id", params.jobId)
    .eq("event", params.event)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    _logger.warn("Failed to fetch latest webhook log", {
      module: "webhook-logs",
      jobId: params.jobId,
      event: params.event,
      error,
    });
    return null;
  }
  return data as WebhookLogRow | null;
}

export async function getLatestWebhookLogsByJob(params: {
  jobIds: string[];
  event: string;
}): Promise<Map<string, WebhookLogRow>> {
  const result = new Map<string, WebhookLogRow>();
  if (params.jobIds.length === 0) return result;

  const { data, error } = await supabase_rr_service
    .from("webhook_logs")
    .select(
      "id,success,error,status_code,latency_ms,url,event,created_at,crawl_id",
    )
    .in("crawl_id", params.jobIds)
    .eq("event", params.event)
    .order("created_at", { ascending: false });

  if (error) {
    _logger.warn("Failed to fetch webhook logs batch", {
      module: "webhook-logs",
      event: params.event,
      error,
    });
    return result;
  }

  for (const row of (data ?? []) as (WebhookLogRow & { crawl_id: string })[]) {
    if (!result.has(row.crawl_id)) result.set(row.crawl_id, row);
  }
  return result;
}
