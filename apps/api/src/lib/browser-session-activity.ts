import { redisEvictConnection } from "../services/redis";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { logger as _logger } from "./logger";

const logger = _logger.child({ module: "browser-sessions" });

const QUEUE_KEY = "browser-session-activity-queue";
const BATCH_SIZE = 500;

interface BrowserSessionActivityEvent {
  team_id: string;
  session_id: string;
  source: "interact" | "browser";
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

  redisEvictConnection.rpush(QUEUE_KEY, JSON.stringify(row)).catch(() => {});
}

export async function processBrowserSessionActivityJobs() {
  const raw = (await redisEvictConnection.lpop(QUEUE_KEY, BATCH_SIZE)) ?? [];
  if (raw.length === 0) return;

  const rows: BrowserSessionActivityEvent[] = raw.map(x => JSON.parse(x));

  try {
    await db.insert(schema.browser_session_activities).values(rows);
  } catch (err) {
    logger.error("Error inserting browser session activities", {
      err,
      count: rows.length,
    });
  }
}
