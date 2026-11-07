import { randomBytes } from "crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db, dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { logger as _logger } from "../../lib/logger";

const logger = _logger.child({ module: "monitor-email-recipients" });

const POSTGRES_UNIQUE_VIOLATION = "23505";

type MonitorEmailRecipientStatus = "pending" | "confirmed" | "unsubscribed";

type MonitorEmailRecipientSource = "team" | "opt_in" | "legacy";

export type MonitorEmailRecipientRow = {
  id: string;
  monitor_id: string;
  team_id: string;
  email: string;
  status: MonitorEmailRecipientStatus;
  token: string;
  source: MonitorEmailRecipientSource;
  confirmation_sent_at: string | null;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  last_notified_at: string | null;
  created_at: string;
  updated_at: string;
};

export function normalizeRecipientEmail(email: string): string {
  return email.trim().toLowerCase();
}

// 32 bytes → 43 chars base64url, no padding. 256 bits of entropy.
function generateRecipientToken(): string {
  return randomBytes(32).toString("base64url");
}

async function run<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(
      `${message}: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
  }
}

export async function listMonitorEmailRecipients(
  monitorId: string,
): Promise<MonitorEmailRecipientRow[]> {
  const data = await run(
    () =>
      dbRr
        .select()
        .from(schema.monitor_email_recipients)
        .where(eq(schema.monitor_email_recipients.monitor_id, monitorId)),
    "Failed to list monitor email recipients",
  );
  return data as MonitorEmailRecipientRow[];
}

async function getRecipientByToken(
  token: string,
): Promise<MonitorEmailRecipientRow | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const [data] = await run(
    () =>
      dbRr
        .select()
        .from(schema.monitor_email_recipients)
        .where(eq(schema.monitor_email_recipients.token, trimmed))
        .limit(1),
    "Failed to look up monitor email recipient by token",
  );
  return (data ?? null) as MonitorEmailRecipientRow | null;
}

export async function getMonitorNameById(
  monitorId: string,
): Promise<string | null> {
  try {
    const [data] = await dbRr
      .select({ name: schema.monitors.name })
      .from(schema.monitors)
      .where(eq(schema.monitors.id, monitorId))
      .limit(1);
    return data?.name ?? null;
  } catch (error) {
    logger.warn("Failed to load monitor name for opt-in response", {
      error,
      monitorId,
    });
    return null;
  }
}

// Team members are auto-confirmed; they already have dashboard access.
export async function getTeamMemberEmails(
  teamId: string,
  emails: string[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();

  let rows: { email: string | null }[];
  try {
    rows = await dbRr
      .select({ email: schema.users.email })
      .from(schema.user_teams)
      .innerJoin(schema.users, eq(schema.user_teams.user_id, schema.users.id))
      .where(eq(schema.user_teams.team_id, teamId));
  } catch (error) {
    logger.warn("Failed to load team member emails for recipient sync", {
      error,
      teamId,
    });
    return new Set();
  }

  const wanted = new Set(emails.map(normalizeRecipientEmail));
  const matches = new Set<string>();
  for (const row of rows) {
    if (typeof row.email === "string") {
      const normalized = normalizeRecipientEmail(row.email);
      if (wanted.has(normalized)) matches.add(normalized);
    }
  }
  return matches;
}

type RecipientUpsertInput = {
  email: string;
  source: MonitorEmailRecipientSource;
  status: MonitorEmailRecipientStatus;
};

type RecipientUpsertResult = {
  row: MonitorEmailRecipientRow;
  created: boolean;
};

async function fetchRecipientByMonitorEmail(
  monitorId: string,
  email: string,
): Promise<MonitorEmailRecipientRow | null> {
  const [data] = await run(
    () =>
      dbRr
        .select()
        .from(schema.monitor_email_recipients)
        .where(
          and(
            eq(schema.monitor_email_recipients.monitor_id, monitorId),
            eq(schema.monitor_email_recipients.email, email),
          ),
        )
        .limit(1),
    "Failed to look up monitor email recipient",
  );
  return (data ?? null) as MonitorEmailRecipientRow | null;
}

// Read replicas can lag behind a freshly-committed INSERT, which is exactly
// the moment this re-fetch runs (the concurrent writer just won the unique
// race). Reading from the primary guarantees we see their row.
async function fetchRecipientByMonitorEmailPrimary(
  monitorId: string,
  email: string,
): Promise<MonitorEmailRecipientRow | null> {
  const [data] = await run(
    () =>
      db
        .select()
        .from(schema.monitor_email_recipients)
        .where(
          and(
            eq(schema.monitor_email_recipients.monitor_id, monitorId),
            eq(schema.monitor_email_recipients.email, email),
          ),
        )
        .limit(1),
    "Failed to look up monitor email recipient",
  );
  return (data ?? null) as MonitorEmailRecipientRow | null;
}

// Same rationale as ...Primary above: a conditional UPDATE just landed, so
// the replica may not have caught up yet when we re-read.
async function fetchRecipientByIdPrimary(
  id: string,
): Promise<MonitorEmailRecipientRow | null> {
  const [data] = await run(
    () =>
      db
        .select()
        .from(schema.monitor_email_recipients)
        .where(eq(schema.monitor_email_recipients.id, id))
        .limit(1),
    "Failed to look up monitor email recipient by id",
  );
  return (data ?? null) as MonitorEmailRecipientRow | null;
}

// Idempotent: existing rows are returned unchanged so prior unsubscribe
// decisions persist across monitor edits. The unique (monitor_id, email)
// constraint is the source of truth — a TOCTOU between the SELECT and the
// INSERT below is caught via the unique-violation handler so concurrent
// syncs of the same monitor return the same row instead of 500ing.
export async function ensureMonitorEmailRecipient(params: {
  monitorId: string;
  teamId: string;
  input: RecipientUpsertInput;
}): Promise<RecipientUpsertResult> {
  const email = normalizeRecipientEmail(params.input.email);

  const existing = await fetchRecipientByMonitorEmail(params.monitorId, email);
  if (existing) {
    return { row: existing, created: false };
  }

  const now = new Date().toISOString();
  const insert = {
    monitor_id: params.monitorId,
    team_id: params.teamId,
    email,
    status: params.input.status,
    token: generateRecipientToken(),
    source: params.input.source,
    confirmation_sent_at: params.input.status === "pending" ? now : null,
    confirmed_at: params.input.status === "confirmed" ? now : null,
    created_at: now,
    updated_at: now,
  };

  let data: MonitorEmailRecipientRow | undefined;
  try {
    [data] = (await db
      .insert(schema.monitor_email_recipients)
      .values(insert)
      .returning()) as MonitorEmailRecipientRow[];
  } catch (error) {
    if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
      const winner = await fetchRecipientByMonitorEmailPrimary(
        params.monitorId,
        email,
      );
      if (winner) {
        return { row: winner, created: false };
      }
    }
    throw new Error(
      `Failed to insert monitor email recipient: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
  }

  return { row: data as MonitorEmailRecipientRow, created: true };
}

export async function markRecipientConfirmationSent(id: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    () =>
      db
        .update(schema.monitor_email_recipients)
        .set({ confirmation_sent_at: now, updated_at: now })
        .where(eq(schema.monitor_email_recipients.id, id)),
    "Failed to mark recipient confirmation sent",
  );
}

export async function confirmRecipientByToken(
  token: string,
): Promise<MonitorEmailRecipientRow | null> {
  const row = await getRecipientByToken(token);
  if (!row) return null;
  if (row.status === "confirmed") return row;

  // Unsubscribe is permanent — never let a confirm link reverse it.
  if (row.status === "unsubscribed") return row;

  // Conditional UPDATE: only transition pending → confirmed. If status flips
  // (e.g. concurrent unsubscribe) between our SELECT and this UPDATE we
  // affect 0 rows; re-fetch and return the actual current state so an
  // in-flight confirm can't silently overwrite a terminal unsubscribe.
  const now = new Date().toISOString();
  const [data] = await run(
    () =>
      db
        .update(schema.monitor_email_recipients)
        .set({ status: "confirmed", confirmed_at: now, updated_at: now })
        .where(
          and(
            eq(schema.monitor_email_recipients.id, row.id),
            eq(schema.monitor_email_recipients.status, "pending"),
          ),
        )
        .returning(),
    "Failed to confirm monitor email recipient",
  );
  if (data) return data as MonitorEmailRecipientRow;

  return await fetchRecipientByIdPrimary(row.id);
}

export async function unsubscribeRecipientByToken(
  token: string,
): Promise<MonitorEmailRecipientRow | null> {
  const row = await getRecipientByToken(token);
  if (!row) return null;
  if (row.status === "unsubscribed") return row;

  // Conditional UPDATE: only writes when the row isn't already unsubscribed,
  // so two racing unsubscribes don't double-write timestamps. 0 rows here
  // means a concurrent call beat us to the terminal state.
  const now = new Date().toISOString();
  const [data] = await run(
    () =>
      db
        .update(schema.monitor_email_recipients)
        .set({ status: "unsubscribed", unsubscribed_at: now, updated_at: now })
        .where(
          and(
            eq(schema.monitor_email_recipients.id, row.id),
            ne(schema.monitor_email_recipients.status, "unsubscribed"),
          ),
        )
        .returning(),
    "Failed to unsubscribe monitor email recipient",
  );
  if (data) return data as MonitorEmailRecipientRow;

  return await fetchRecipientByIdPrimary(row.id);
}

export async function touchRecipientsNotified(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  try {
    await db
      .update(schema.monitor_email_recipients)
      .set({ last_notified_at: now, updated_at: now })
      .where(inArray(schema.monitor_email_recipients.id, ids));
  } catch (error) {
    logger.warn("Failed to update last_notified_at on recipients", {
      error,
      ids,
    });
  }
}
