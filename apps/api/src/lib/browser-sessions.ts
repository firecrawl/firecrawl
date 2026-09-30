import { z } from "zod";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, like, lte, ne, sql } from "drizzle-orm";
import { getValue, setValue } from "../services/redis";
import { redisRateLimitClient } from "../services/rate-limiter";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { browserProfileDeletedKey } from "./browser-profiles";

type BrowserSessionStatus = "active" | "destroyed" | "error";

export interface BrowserSessionRow {
  id: string;
  team_id: string;
  request_id: string | null;
  should_bill: boolean;
  scrape_id?: string | null; // linked scrape job id for /scrape/:jobId/interact sessions
  browser_id: string; // Hangar browser id
  workspace_id: string; // unused (legacy), stored as ""
  context_id: string; // Hangar playlist URL; empty when recording is disabled
  cdp_url: string; // Hangar CDP WebSocket URL
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

export async function listUnsettledHangarSessions(cursor: {
  after?: string;
  through?: string;
}): Promise<{ sessions: BrowserSessionRow[]; through: string | null }> {
  const unsettled = and(
    eq(schema.browser_sessions.status, "active"),
    like(schema.browser_sessions.browser_id, "br\\_%"),
  );
  let through = cursor.through;
  const after = through ? cursor.after : undefined;
  if (!through) {
    const [last] = await db
      .select({ id: schema.browser_sessions.id })
      .from(schema.browser_sessions)
      .where(unsettled)
      .orderBy(desc(schema.browser_sessions.id))
      .limit(1);
    through = last?.id;
  }
  if (!through) return { sessions: [], through: null };
  const sessions = (await db
    .select()
    .from(schema.browser_sessions)
    .where(
      and(
        unsettled,
        lte(schema.browser_sessions.id, through),
        after ? gt(schema.browser_sessions.id, after) : undefined,
      ),
    )
    .orderBy(asc(schema.browser_sessions.id))
    .limit(20)) as BrowserSessionRow[];
  return { sessions, through };
}

/** Serialize prompt-rate changes and settlement across replicas. */
export async function withLockedBrowserSession<T>(
  id: string,
  run: (
    session: BrowserSessionRow,
    tx: Pick<typeof db, "update">,
  ) => Promise<T>,
): Promise<T> {
  return db.transaction(async tx => {
    const [row] = await tx
      .select()
      .from(schema.browser_sessions)
      .where(eq(schema.browser_sessions.id, id))
      .for("update");
    if (!row) throw new Error("Browser session not found.");
    return run(row as BrowserSessionRow, tx);
  });
}

/** Record the billed amount once; a failed bill leaves the row unsettled for retry. */
export async function settleBrowserSessionOnce(
  id: string,
  bill: (session: BrowserSessionRow) => Promise<number>,
): Promise<{ creditsBilled: number; newlySettled: boolean }> {
  return withLockedBrowserSession(id, async (row, tx) => {
    if (row.status === "destroyed" || row.credits_used !== null)
      return { creditsBilled: row.credits_used ?? 0, newlySettled: false };
    const creditsBilled = await bill(row);
    await tx
      .update(schema.browser_sessions)
      .set({
        credits_used: creditsBilled,
        updated_at: new Date().toISOString(),
      })
      .where(eq(schema.browser_sessions.id, id));
    return { creditsBilled, newlySettled: true };
  });
}

/** Keep the row discoverable until its keyless refund and slot release succeed. */
export async function completeBrowserSessionSettlement(id: string) {
  const completed = await db
    .update(schema.browser_sessions)
    .set({
      status: "destroyed",
      deleted_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.browser_sessions.id, id),
        ne(schema.browser_sessions.status, "destroyed"),
        sql`${schema.browser_sessions.credits_used} IS NOT NULL`,
      ),
    )
    .returning({ id: schema.browser_sessions.id });
  return completed.length > 0;
}

export async function insertBrowserSession(
  row: Omit<BrowserSessionRow, "created_at" | "updated_at">,
): Promise<BrowserSessionRow> {
  const now = new Date().toISOString();
  const [data] = await db
    .insert(schema.browser_sessions)
    .values({ ...row, created_at: now, updated_at: now })
    .returning();
  return data as BrowserSessionRow;
}

export async function getBrowserSession(
  id: string,
): Promise<BrowserSessionRow | null> {
  const [data] = await db
    .select()
    .from(schema.browser_sessions)
    .where(eq(schema.browser_sessions.id, id))
    .limit(1);
  return (data ?? null) as BrowserSessionRow | null;
}

export async function getBrowserSessionFromScrape(
  id: string,
): Promise<BrowserSessionRow | null> {
  // scrape_id is not unique: two concurrent interact calls on one scrape can
  // each insert a row. Prefer the newest row that is not destroyed, so that
  // callers act on a live session. Fall back to the newest destroyed row.
  const rows = (await db
    .select()
    .from(schema.browser_sessions)
    .where(eq(schema.browser_sessions.scrape_id, id))
    .orderBy(desc(schema.browser_sessions.created_at))) as BrowserSessionRow[];
  return rows.find(row => row.status !== "destroyed") ?? rows[0] ?? null;
}

export async function listBrowserSessions(
  teamId: string,
  opts?: { status?: BrowserSessionStatus },
): Promise<BrowserSessionRow[]> {
  return (await db
    .select()
    .from(schema.browser_sessions)
    .where(
      and(
        eq(schema.browser_sessions.team_id, teamId),
        opts?.status
          ? eq(schema.browser_sessions.status, opts.status)
          : undefined,
      ),
    )
    .orderBy(desc(schema.browser_sessions.created_at))) as BrowserSessionRow[];
}

export async function listActiveBrowserSessionsForRequest(
  teamId: string,
  requestId: string,
): Promise<BrowserSessionRow[]> {
  return (await db
    .select()
    .from(schema.browser_sessions)
    .where(
      and(
        eq(schema.browser_sessions.team_id, teamId),
        eq(schema.browser_sessions.request_id, requestId),
        eq(schema.browser_sessions.status, "active"),
      ),
    )
    .orderBy(desc(schema.browser_sessions.created_at))) as BrowserSessionRow[];
}

export async function updateBrowserSessionActivity(id: string): Promise<void> {
  await db
    .update(schema.browser_sessions)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(schema.browser_sessions.id, id));
}

export async function updateBrowserSessionScrapeId(
  id: string,
  scrapeId: string,
): Promise<void> {
  await db
    .update(schema.browser_sessions)
    .set({ scrape_id: scrapeId, updated_at: new Date().toISOString() })
    .where(eq(schema.browser_sessions.id, id));
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
