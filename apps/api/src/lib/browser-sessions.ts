import { z } from "zod";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, like, sql } from "drizzle-orm";
import { deleteKey, getValue, setValue } from "../services/redis";
import { redisRateLimitClient } from "../services/rate-limiter";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { browserProfileDeletedKey } from "./browser-profiles";
import { logger as _logger } from "./logger";

const logger = _logger.child({ module: "browser-sessions" });

function activeBrowserCountKey(teamId: string): string {
  return `browser_sessions:active_count:${teamId}`;
}

type BrowserSessionStatus = "active" | "destroyed" | "error";

export interface BrowserSessionRow {
  id: string;
  team_id: string;
  request_id: string | null;
  should_bill: boolean;
  scrape_id?: string | null; // linked scrape job id for /scrape/:jobId/interact sessions
  browser_id: string; // browser service sessionId
  workspace_id: string; // unused (legacy), stored as ""
  context_id: string; // Hangar playlist URL; empty when recording is disabled
  cdp_url: string; // full CDP WebSocket URL from browser service
  cdp_path: string; // Hangar view URL
  cdp_interactive_path: string; // Hangar control URL
  stream_web_view: boolean;
  status: BrowserSessionStatus;
  ttl_total: number;
  ttl_without_activity: number | null;
  credits_used: number | null;
  profile_name?: string | null; // persistent profile the session was created with
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
}

export async function listUnsettledHangarSessions(
  after?: string,
): Promise<BrowserSessionRow[]> {
  return (await db
    .select()
    .from(schema.browser_sessions)
    .where(
      and(
        eq(schema.browser_sessions.status, "active"),
        like(schema.browser_sessions.browser_id, "br\\_%"),
        after ? gt(schema.browser_sessions.id, after) : undefined,
      ),
    )
    .orderBy(asc(schema.browser_sessions.id))
    .limit(20)) as BrowserSessionRow[];
}

/** Serialize billing across replicas and persist its receipt before cleanup. */
export async function settleBrowserSessionOnce(
  id: string,
  bill: (session: BrowserSessionRow) => Promise<number>,
): Promise<{ creditsBilled: number; newlySettled: boolean }> {
  return db.transaction(async tx => {
    const [row] = await tx
      .select()
      .from(schema.browser_sessions)
      .where(eq(schema.browser_sessions.id, id))
      .for("update");
    if (!row) throw new Error("Browser session not found.");
    if (row.status === "destroyed" || row.credits_used !== null)
      return { creditsBilled: row.credits_used ?? 0, newlySettled: false };
    const creditsBilled = await bill(row as BrowserSessionRow);
    const now = new Date().toISOString();
    await tx
      .update(schema.browser_sessions)
      .set({
        credits_used: creditsBilled,
        updated_at: now,
      })
      .where(eq(schema.browser_sessions.id, id));
    return { creditsBilled, newlySettled: true };
  });
}

/** Keep the row discoverable until its keyless refund and slot release succeed. */
export async function completeBrowserSessionSettlement(id: string) {
  await db
    .update(schema.browser_sessions)
    .set({
      status: "destroyed",
      deleted_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.browser_sessions.id, id),
        sql`${schema.browser_sessions.credits_used} IS NOT NULL`,
      ),
    );
}

export async function activateBrowserSession(id: string, shouldBill: boolean) {
  const [row] = await db
    .update(schema.browser_sessions)
    .set({ should_bill: shouldBill })
    .where(
      and(
        eq(schema.browser_sessions.id, id),
        eq(schema.browser_sessions.status, "active"),
        sql`${schema.browser_sessions.credits_used} IS NULL`,
      ),
    )
    .returning();
  if (!row) throw new Error("Browser session stopped during initialization.");
  return row as BrowserSessionRow;
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
    // scrape_id is not unique: two concurrent interact calls on one scrape can
    // each insert a row. Prefer the newest row that is not destroyed, so that
    // callers act on a live session. Fall back to the newest destroyed row.
    const rows = (await db
      .select()
      .from(schema.browser_sessions)
      .where(eq(schema.browser_sessions.scrape_id, id))
      .orderBy(
        desc(schema.browser_sessions.created_at),
      )) as BrowserSessionRow[];
    return rows.find(row => row.status !== "destroyed") ?? rows[0] ?? null;
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

export async function listActiveBrowserSessionsForRequest(
  teamId: string,
  requestId: string,
): Promise<BrowserSessionRow[]> {
  try {
    const data = await db
      .select()
      .from(schema.browser_sessions)
      .where(
        and(
          eq(schema.browser_sessions.team_id, teamId),
          eq(schema.browser_sessions.request_id, requestId),
          eq(schema.browser_sessions.status, "active"),
        ),
      )
      .orderBy(desc(schema.browser_sessions.created_at));
    return data as BrowserSessionRow[];
  } catch (error) {
    logger.error("Failed to list active browser sessions for request", {
      error,
      teamId,
      requestId,
    });
    throw new Error(
      `Failed to list active browser sessions for request: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
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

// Records a successful save of a persistent profile. Throws on failure so the
// Hangar reconciliation retries the update.
export async function upsertBrowserProfile(input: {
  teamId: string;
  name: string;
  savedAt: string;
  sizeBytes: number | undefined;
}): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${browserProfileDeletedKey(input.teamId, input.name)}, 0))`,
    );
    const deletedAt = await getBrowserProfileDeletedAt(
      input.teamId,
      input.name,
    );
    if (deletedAt && !(Date.parse(input.savedAt) > Date.parse(deletedAt)))
      return;
    const profiles = schema.browser_profiles;
    await tx
      .insert(profiles)
      .values({
        team_id: input.teamId,
        name: input.name,
        saved_at: input.savedAt,
        size_bytes: input.sizeBytes ?? null,
      })
      .onConflictDoUpdate({
        target: [profiles.team_id, profiles.name],
        // Retried deliveries can arrive out of order, so an older save never
        // replaces a newer one. A save that reported no size keeps the last
        // known size rather than erasing it.
        set: {
          saved_at: sql`GREATEST(${profiles.saved_at}, excluded.saved_at)`,
          size_bytes: sql`CASE WHEN excluded.saved_at >= ${profiles.saved_at} THEN COALESCE(excluded.size_bytes, ${profiles.size_bytes}) ELSE ${profiles.size_bytes} END`,
        },
      });
  });
}

// Prevents late reconciliation of an earlier save from relisting a deleted
// profile. Outlives the browser
// metadata retention and background reconciliation window.
const PROFILE_DELETED_TTL_SECONDS = 2 * 86400;

// Keeps the newest deletion time: responses to concurrent deletes can land
// out of order, and an older time must not shrink the window. Timestamps are
// normalized with toISOString, which compares in time order.
const SET_IF_NEWER_LUA = `
  local current = redis.call('GET', KEYS[1])
  if (not current) or current < ARGV[1] then
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  end
  return 1
`;

async function recordBrowserProfileDeleted(
  teamId: string,
  name: string,
  deletedAt: string,
): Promise<void> {
  await redisRateLimitClient.eval(
    SET_IF_NEWER_LUA,
    1,
    browserProfileDeletedKey(teamId, name),
    new Date(deletedAt).toISOString(),
    String(PROFILE_DELETED_TTL_SECONDS),
  );
}

async function getBrowserProfileDeletedAt(
  teamId: string,
  name: string,
): Promise<string | null> {
  // Keep honoring tombstones written by the previous deployment (one-hour TTL).
  const teamHash = createHash("sha256")
    .update(teamId)
    .digest("hex")
    .slice(0, 16);
  const values = await Promise.all([
    getValue(browserProfileDeletedKey(teamId, name)),
    getValue(`browser-profile-deleted:${teamHash}_${name}`),
  ]);
  const tombstones = values.filter((value): value is string => value !== null);
  if (tombstones.some(value => !Number.isFinite(Date.parse(value))))
    throw new Error("Invalid browser profile deletion timestamp.");
  return (
    tombstones.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null
  );
}

// Removes a profile's listing once its saved state is deleted. Keyless callers
// (non-UUID team ids) are never listed, so there is nothing to remove.
export async function deleteBrowserProfile(
  teamId: string,
  name: string,
  deletedAt: string,
): Promise<void> {
  if (!z.uuid().safeParse(teamId).success) {
    await recordBrowserProfileDeleted(teamId, name, deletedAt);
    return;
  }
  await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${browserProfileDeletedKey(teamId, name)}, 0))`,
    );
    await recordBrowserProfileDeleted(teamId, name, deletedAt);
    const profiles = schema.browser_profiles;
    await tx
      .delete(profiles)
      .where(
        and(
          eq(profiles.team_id, teamId),
          eq(profiles.name, name),
          sql`${profiles.saved_at} <= ${deletedAt}`,
        ),
      );
  });
}

// ---------------------------------------------------------------------------
// Prompt usage tracking (Redis)
// ---------------------------------------------------------------------------

function promptFlagKey(sessionId: string): string {
  return `browser_session:used_prompt:${sessionId}`;
}

export async function markBrowserSessionUsedPrompt(
  sessionId: string,
): Promise<void> {
  await setValue(promptFlagKey(sessionId), "1", PROFILE_DELETED_TTL_SECONDS);
}

export async function didBrowserSessionUsePrompt(
  sessionId: string,
): Promise<boolean> {
  return (await getValue(promptFlagKey(sessionId))) === "1";
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
