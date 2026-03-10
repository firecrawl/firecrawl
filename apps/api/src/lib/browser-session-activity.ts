import { redisEvictConnection } from "../services/redis";
import { supabase_service } from "../services/supabase";
import { logger as _logger } from "./logger";

const logger = _logger.child({ module: "browser-sessions" });

const QUEUE_KEY = "browser-session-activity-queue";
const BATCH_SIZE = 500;

interface BrowserSessionActivityEvent {
  team_id: string;
  session_id: string;
  language: string;
  timeout: number;
  exit_code: number | null;
  killed: boolean;
  created_at: string;
}

export function enqueueBrowserSessionActivity(
  event: Omit<BrowserSessionActivityEvent, "created_at">,
) {
  const row: BrowserSessionActivityEvent = {
    ...event,
    created_at: new Date().toISOString(),
  };

  redisEvictConnection
    .rpush(QUEUE_KEY, JSON.stringify(row))
    .catch(() => {});
}

export async function processBrowserSessionActivityJobs() {
  const raw =
    (await redisEvictConnection.lpop(QUEUE_KEY, BATCH_SIZE)) ?? [];
  if (raw.length === 0) return;

  const rows: BrowserSessionActivityEvent[] = raw.map((x) => JSON.parse(x));

  try {
    const { error } = await supabase_service
      .from("browser_session_activities")
      .insert(rows);

    if (error) {
      logger.error("Failed to insert browser session activities", {
        error,
        count: rows.length,
      });
    }
  } catch (err) {
    logger.error("Error inserting browser session activities", {
      err,
      count: rows.length,
    });
  }
}
