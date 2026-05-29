import { randomBytes } from "crypto";
import { logger as _logger } from "../../lib/logger";
import { supabase_rr_service, supabase_service } from "../supabase";

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

function throwIfError(error: any, message: string): void {
  if (error) {
    throw new Error(`${message}: ${error.message ?? JSON.stringify(error)}`);
  }
}

export async function listMonitorEmailRecipients(
  monitorId: string,
): Promise<MonitorEmailRecipientRow[]> {
  const { data, error } = await supabase_rr_service
    .from("monitor_email_recipients")
    .select("*")
    .eq("monitor_id", monitorId);

  throwIfError(error, "Failed to list monitor email recipients");
  return (data ?? []) as MonitorEmailRecipientRow[];
}

async function getRecipientByToken(
  token: string,
): Promise<MonitorEmailRecipientRow | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const { data, error } = await supabase_rr_service
    .from("monitor_email_recipients")
    .select("*")
    .eq("token", trimmed)
    .maybeSingle();

  throwIfError(error, "Failed to look up monitor email recipient by token");
  return (data ?? null) as MonitorEmailRecipientRow | null;
}

export async function getMonitorNameById(
  monitorId: string,
): Promise<string | null> {
  const { data, error } = await supabase_rr_service
    .from("monitors")
    .select("name")
    .eq("id", monitorId)
    .maybeSingle();

  if (error) {
    logger.warn("Failed to load monitor name for opt-in response", {
      error,
      monitorId,
    });
    return null;
  }
  return (data?.name as string | undefined) ?? null;
}

// Team members are auto-confirmed; they already have dashboard access.
export async function getTeamMemberEmails(
  teamId: string,
  emails: string[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();

  const { data, error } = await supabase_rr_service
    .from("user_teams")
    .select("users(email)")
    .eq("team_id", teamId);

  if (error) {
    logger.warn("Failed to load team member emails for recipient sync", {
      error,
      teamId,
    });
    return new Set();
  }

  const wanted = new Set(emails.map(normalizeRecipientEmail));
  const matches = new Set<string>();
  for (const row of data ?? []) {
    const email = (row as any).users?.email;
    if (typeof email === "string") {
      const normalized = normalizeRecipientEmail(email);
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
  const { data, error } = await supabase_rr_service
    .from("monitor_email_recipients")
    .select("*")
    .eq("monitor_id", monitorId)
    .eq("email", email)
    .maybeSingle();
  throwIfError(error, "Failed to look up monitor email recipient");
  return (data ?? null) as MonitorEmailRecipientRow | null;
}

// Read replicas can lag behind a freshly-committed INSERT, which is exactly
// the moment this re-fetch runs (the concurrent writer just won the unique
// race). Reading from the primary guarantees we see their row.
async function fetchRecipientByMonitorEmailPrimary(
  monitorId: string,
  email: string,
): Promise<MonitorEmailRecipientRow | null> {
  const { data, error } = await supabase_service
    .from("monitor_email_recipients")
    .select("*")
    .eq("monitor_id", monitorId)
    .eq("email", email)
    .maybeSingle();
  throwIfError(error, "Failed to look up monitor email recipient");
  return (data ?? null) as MonitorEmailRecipientRow | null;
}

// Same rationale as ...Primary above: a conditional UPDATE just landed, so
// the replica may not have caught up yet when we re-read.
async function fetchRecipientByIdPrimary(
  id: string,
): Promise<MonitorEmailRecipientRow | null> {
  const { data, error } = await supabase_service
    .from("monitor_email_recipients")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  throwIfError(error, "Failed to look up monitor email recipient by id");
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

  const { data, error } = await supabase_service
    .from("monitor_email_recipients")
    .insert(insert)
    .select("*")
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
      const winner = await fetchRecipientByMonitorEmailPrimary(
        params.monitorId,
        email,
      );
      if (winner) {
        return { row: winner, created: false };
      }
    }
    throwIfError(error, "Failed to insert monitor email recipient");
  }

  return { row: data as MonitorEmailRecipientRow, created: true };
}

export async function markRecipientConfirmationSent(id: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase_service
    .from("monitor_email_recipients")
    .update({ confirmation_sent_at: now, updated_at: now })
    .eq("id", id);

  throwIfError(error, "Failed to mark recipient confirmation sent");
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
  const { data, error } = await supabase_service
    .from("monitor_email_recipients")
    .update({ status: "confirmed", confirmed_at: now, updated_at: now })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  throwIfError(error, "Failed to confirm monitor email recipient");
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
  const { data, error } = await supabase_service
    .from("monitor_email_recipients")
    .update({ status: "unsubscribed", unsubscribed_at: now, updated_at: now })
    .eq("id", row.id)
    .neq("status", "unsubscribed")
    .select("*")
    .maybeSingle();

  throwIfError(error, "Failed to unsubscribe monitor email recipient");
  if (data) return data as MonitorEmailRecipientRow;

  return await fetchRecipientByIdPrimary(row.id);
}

export async function touchRecipientsNotified(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await supabase_service
    .from("monitor_email_recipients")
    .update({ last_notified_at: now, updated_at: now })
    .in("id", ids);

  if (error) {
    logger.warn("Failed to update last_notified_at on recipients", {
      error,
      ids,
    });
  }
}
