import { supabase_service } from "../services/supabase";
import { getValue, setValue, deleteKey } from "../services/redis";
import { logger as _logger } from "./logger";

const logger = _logger.child({ module: "browser-sessions" });

export const MAX_ACTIVE_BROWSER_SESSIONS_PER_TEAM = 20;
const ACTIVE_COUNT_CACHE_TTL_SECONDS = 300;

function activeBrowserCountKey(teamId: string): string {
  return `browser_sessions:active_count:${teamId}`;
}

type BrowserSessionStatus = "active" | "destroyed" | "error";

interface BrowserSessionRow {
  id: string;
  team_id: string;
  browser_id: string; // browser service sessionId
  workspace_id: string; // unused (legacy), stored as ""
  context_id: string; // unused (legacy), stored as ""
  cdp_url: string; // full CDP WebSocket URL from browser service
  cdp_path: string; // repurposed: stores the view WebSocket URL
  stream_web_view: boolean;
  status: BrowserSessionStatus;
  ttl_total: number;
  ttl_without_activity: number | null;
  credits_used: number | null;
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
}

const TABLE = "browser_sessions";

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

export async function insertBrowserSession(
  row: Omit<BrowserSessionRow, "created_at" | "updated_at">,
): Promise<BrowserSessionRow> {
  const now = new Date().toISOString();
  const full: BrowserSessionRow = {
    ...row,
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase_service
    .from(TABLE)
    .insert(full)
    .select()
    .single();

  if (error) {
    logger.error("Failed to insert browser session", { error, id: row.id });
    throw new Error(`Failed to insert browser session: ${error.message}`);
  }

  return data as BrowserSessionRow;
}

export async function getBrowserSession(
  id: string,
): Promise<BrowserSessionRow | null> {
  const { data, error } = await supabase_service
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    // PGRST116 = no rows found
    if (error.code === "PGRST116") return null;
    logger.error("Failed to get browser session", { error, id });
    throw new Error(`Failed to get browser session: ${error.message}`);
  }

  return data as BrowserSessionRow;
}

export async function listBrowserSessions(
  teamId: string,
  opts?: { status?: BrowserSessionStatus },
): Promise<BrowserSessionRow[]> {
  let query = supabase_service
    .from(TABLE)
    .select("*")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false });

  if (opts?.status) {
    query = query.eq("status", opts.status);
  }

  const { data, error } = await query;

  if (error) {
    logger.error("Failed to list browser sessions", { error, teamId });
    throw new Error(`Failed to list browser sessions: ${error.message}`);
  }

  return (data ?? []) as BrowserSessionRow[];
}

export async function updateBrowserSessionActivity(id: string): Promise<void> {
  const { error } = await supabase_service
    .from(TABLE)
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    logger.warn("Failed to update browser session activity", { error, id });
  }
}

export async function getBrowserSessionByBrowserId(
  browserId: string,
): Promise<BrowserSessionRow | null> {
  const { data, error } = await supabase_service
    .from(TABLE)
    .select("*")
    .eq("browser_id", browserId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    logger.error("Failed to get browser session by browser_id", {
      error,
      browserId,
    });
    throw new Error(
      `Failed to get browser session by browser_id: ${error.message}`,
    );
  }

  return data as BrowserSessionRow;
}

export async function updateBrowserSessionStatus(
  id: string,
  status: BrowserSessionStatus,
): Promise<void> {
  const { error } = await supabase_service
    .from(TABLE)
    .update({
      status,
      updated_at: new Date().toISOString(),
      deleted_at: status === "destroyed" ? new Date().toISOString() : null,
    })
    .eq("id", id);

  if (error) {
    logger.warn("Failed to update browser session status", { error, id });
  }
}

export async function claimBrowserSessionDestroyed(
  id: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await supabase_service
    .from(TABLE)
    .update({
      status: "destroyed" as BrowserSessionStatus,
      updated_at: now,
      deleted_at: now,
    })
    .eq("id", id)
    .eq("status", "active")
    .select("id");

  if (error) {
    logger.warn("Failed to claim browser session destroyed", { error, id });
    return false;
  }

  return (data?.length ?? 0) > 0;
}

export async function updateBrowserSessionCreditsUsed(
  id: string,
  creditsUsed: number,
): Promise<void> {
  const { error } = await supabase_service
    .from(TABLE)
    .update({ credits_used: creditsUsed, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    logger.warn("Failed to update browser session credits_used", {
      error,
      id,
      creditsUsed,
    });
  }
}

// ---------------------------------------------------------------------------
// Active session count (cached)
// ---------------------------------------------------------------------------

async function countActiveBrowserSessionsFromDb(
  teamId: string,
): Promise<number> {
  const { count, error } = await supabase_service
    .from(TABLE)
    .select("*", { count: "exact", head: true })
    .eq("team_id", teamId)
    .eq("status", "active");

  if (error) {
    logger.error("Failed to count active browser sessions", { error, teamId });
    throw new Error(
      `Failed to count active browser sessions: ${error.message}`,
    );
  }

  return count ?? 0;
}

/**
 * Returns the number of active browser sessions for a team.
 * Uses a Redis cache with a short TTL to avoid hitting the DB on every request.
 */
export async function getActiveBrowserSessionCount(
  teamId: string,
): Promise<number> {
  const cacheKey = activeBrowserCountKey(teamId);

  try {
    const cached = await getValue(cacheKey);
    if (cached !== null) {
      return parseInt(cached, 10);
    }
  } catch {
    // Redis down — fall through to DB
  }

  const count = await countActiveBrowserSessionsFromDb(teamId);

  try {
    await setValue(cacheKey, String(count), ACTIVE_COUNT_CACHE_TTL_SECONDS);
  } catch {
    // Redis down — non-fatal
  }

  return count;
}

/**
 * Invalidate the cached active session count for a team.
 * Call after creating or destroying a session.
 */
export async function invalidateActiveBrowserSessionCount(
  teamId: string,
): Promise<void> {
  try {
    await deleteKey(activeBrowserCountKey(teamId));
  } catch {
    // Redis down — non-fatal
  }
}
