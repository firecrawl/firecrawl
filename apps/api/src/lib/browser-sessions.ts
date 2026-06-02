import { and, desc, eq } from "drizzle-orm";
import { deleteKey, getValue, setValue } from "../services/redis";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { logger as _logger } from "./logger";

const logger = _logger.child({ module: "browser-sessions" });

function activeBrowserCountKey(teamId: string): string {
  return `browser_sessions:active_count:${teamId}`;
}

type BrowserSessionStatus = "active" | "destroyed" | "error";

interface BrowserSessionRow {
  id: string;
  team_id: string;
  scrape_id?: string | null; // linked scrape job id for /scrape/:jobId/interact sessions
  browser_id: string; // browser service sessionId
  workspace_id: string; // unused (legacy), stored as ""
  context_id: string; // unused (legacy), stored as ""
  cdp_url: string; // full CDP WebSocket URL from browser service
  cdp_path: string; // repurposed: stores the view WebSocket URL
  cdp_interactive_path: string; // repurposed: stores the interactive view WebSocket URL
  stream_web_view: boolean;
  status: BrowserSessionStatus;
  ttl_total: number;
  ttl_without_activity: number | null;
  credits_used: number | null;
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
}

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

  const MAX_ATTEMPTS = 10;
  let lastError: any = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const [data] = await db
        .insert(schema.browser_sessions)
        .values(full)
        .returning();

      return data as BrowserSessionRow;
    } catch (error) {
      lastError = error;
      logger.error("Error inserting browser session, trying again", {
        error,
        id: row.id,
        attempt,
      });
      await new Promise(resolve => setTimeout(resolve, 75));
    }
  }

  logger.error("Failed to insert browser session after all retries", {
    error: lastError,
    id: row.id,
    attempts: MAX_ATTEMPTS,
  });
  throw new Error(
    `Failed to insert browser session: ${lastError?.message ?? "unknown error"}`,
  );
}

export async function getBrowserSession(
  id: string,
): Promise<BrowserSessionRow | null> {
  try {
    const [data] = await db
      .select()
      .from(schema.browser_sessions)
      .where(eq(schema.browser_sessions.id, id))
      .limit(1);
    return (data ?? null) as BrowserSessionRow | null;
  } catch (error) {
    logger.error("Failed to get browser session", { error, id });
    throw new Error(
      `Failed to get browser session: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
  }
}

export async function getBrowserSessionFromScrape(
  id: string,
): Promise<BrowserSessionRow | null> {
  try {
    const [data] = await db
      .select()
      .from(schema.browser_sessions)
      .where(eq(schema.browser_sessions.scrape_id, id))
      .limit(1);
    return (data ?? null) as BrowserSessionRow | null;
  } catch (error) {
    logger.error("Failed to get browser session from scrape", { error, id });
    throw new Error(
      `Failed to get browser session from scrape: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
  }
}

export async function listBrowserSessions(
  teamId: string,
  opts?: { status?: BrowserSessionStatus },
): Promise<BrowserSessionRow[]> {
  const conditions = [eq(schema.browser_sessions.team_id, teamId)];
  if (opts?.status) {
    conditions.push(eq(schema.browser_sessions.status, opts.status));
  }

  try {
    const data = await db
      .select()
      .from(schema.browser_sessions)
      .where(and(...conditions))
      .orderBy(desc(schema.browser_sessions.created_at));
    return data as BrowserSessionRow[];
  } catch (error) {
    logger.error("Failed to list browser sessions", { error, teamId });
    throw new Error(
      `Failed to list browser sessions: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
  }
}

export async function updateBrowserSessionActivity(id: string): Promise<void> {
  try {
    await db
      .update(schema.browser_sessions)
      .set({ updated_at: new Date().toISOString() })
      .where(eq(schema.browser_sessions.id, id));
  } catch (error) {
    logger.warn("Failed to update browser session activity", { error, id });
  }
}

export async function getBrowserSessionByBrowserId(
  browserId: string,
): Promise<BrowserSessionRow | null> {
  try {
    const [data] = await db
      .select()
      .from(schema.browser_sessions)
      .where(eq(schema.browser_sessions.browser_id, browserId))
      .limit(1);
    return (data ?? null) as BrowserSessionRow | null;
  } catch (error) {
    logger.error("Failed to get browser session by browser_id", {
      error,
      browserId,
    });
    throw new Error(
      `Failed to get browser session by browser_id: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
  }
}

export async function updateBrowserSessionStatus(
  id: string,
  status: BrowserSessionStatus,
): Promise<void> {
  try {
    await db
      .update(schema.browser_sessions)
      .set({
        status,
        updated_at: new Date().toISOString(),
        deleted_at: status === "destroyed" ? new Date().toISOString() : null,
      })
      .where(eq(schema.browser_sessions.id, id));
  } catch (error) {
    logger.warn("Failed to update browser session status", { error, id });
  }
}

export async function claimBrowserSessionDestroyed(
  id: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    const data = await db
      .update(schema.browser_sessions)
      .set({
        status: "destroyed" as BrowserSessionStatus,
        updated_at: now,
        deleted_at: now,
      })
      .where(
        and(
          eq(schema.browser_sessions.id, id),
          eq(schema.browser_sessions.status, "active"),
        ),
      )
      .returning({ id: schema.browser_sessions.id });
    return data.length > 0;
  } catch (error) {
    logger.warn("Failed to claim browser session destroyed", { error, id });
    return false;
  }
}

export async function updateBrowserSessionScrapeId(
  id: string,
  scrapeId: string,
): Promise<void> {
  try {
    await db
      .update(schema.browser_sessions)
      .set({ scrape_id: scrapeId, updated_at: new Date().toISOString() })
      .where(eq(schema.browser_sessions.id, id));
  } catch (error) {
    logger.warn("Failed to update browser session scrape_id", {
      error,
      id,
      scrapeId,
    });
  }
}

export async function updateBrowserSessionCreditsUsed(
  id: string,
  creditsUsed: number,
): Promise<void> {
  try {
    await db
      .update(schema.browser_sessions)
      .set({
        credits_used: creditsUsed,
        updated_at: new Date().toISOString(),
      })
      .where(eq(schema.browser_sessions.id, id));
  } catch (error) {
    logger.warn("Failed to update browser session credits_used", {
      error,
      id,
      creditsUsed,
    });
  }
}

// ---------------------------------------------------------------------------
// Prompt usage tracking (Redis)
// ---------------------------------------------------------------------------

const PROMPT_FLAG_TTL_SECONDS = 7200; // 2 hours, well beyond max session TTL

function promptFlagKey(sessionId: string): string {
  return `browser_session:used_prompt:${sessionId}`;
}

export async function markBrowserSessionUsedPrompt(
  sessionId: string,
): Promise<void> {
  try {
    await setValue(promptFlagKey(sessionId), "1", PROMPT_FLAG_TTL_SECONDS);
  } catch {
    // Redis down — non-fatal, will fall back to standard rate at billing time
  }
}

export async function didBrowserSessionUsePrompt(
  sessionId: string,
): Promise<boolean> {
  try {
    const val = await getValue(promptFlagKey(sessionId));
    return val === "1";
  } catch {
    return false;
  }
}

export async function clearBrowserSessionPromptFlag(
  sessionId: string,
): Promise<void> {
  try {
    await deleteKey(promptFlagKey(sessionId));
  } catch {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// Active session count (cached)
// ---------------------------------------------------------------------------

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
