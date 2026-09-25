import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { clearACUCForTeam } from "../../controllers/auth";
import { db } from "../../db/connection";
import {
  api_keys,
  organization_data_source_access as accessTable,
  teams,
  user_teams,
} from "../../db/schema";
import { logger as rootLogger } from "../../lib/logger";
import { exchangeRequest } from "./client";

/**
 * Mirrors a provider-terms acceptance recorded in the Exchange ledger (the
 * `firecrawl/terms/accept` capability, or `POST /exchange/provider-terms/accept`)
 * into the organization's access record, `organization_data_source_access`,
 * the same row the dashboard's "Choose your data providers" flow writes and
 * the auth chunk projects as `flags.organizationDataSourceAccess`. Without it
 * an API/CLI/MCP acceptance lives only in the ledger: `authorizeProviders`
 * falls back to the ledger, but anything that reads the flags alone (the
 * Agent's `gatedProviders`) keeps treating the provider as unaccepted.
 *
 * The ledger stays the record of consent and is written first; this only
 * derives the row from it. Nothing here throws: a failed mirror is logged and
 * the acceptance still stands, because the API honours the ledger and the
 * backfill (`backfillProviderAccess`) re-derives the row from it.
 *
 * The rules follow firecrawl-web, which owns the other writes:
 *   - which ledger acceptance may enable a row: `reconcileProviderAccess`
 *     (lib/exchange/provider-access-state.ts), the projection the dashboard
 *     already shows for ledger-only acceptances, and `authorizeProviders` here;
 *   - what an accept writes: `changeProviderAccess(..., "accept")`
 *     (lib/exchange/provider-access-server.ts);
 *   - who may accept with an API key: `providerAccessContextForApiKey`, an
 *     admin's own key, or any key of the organization while it has elected
 *     to allow agent acceptance;
 *   - cache: `refreshOrganizationDataSourceAccessState`, clear the auth chunk
 *     of every team of the organization.
 */

const EXCHANGE_TIMEOUT_MS = 5_000;
const WRITE_ATTEMPTS = 3;
const OWNER_REVOCATION = "revoked_by_organization_admin";

type AccessRow = typeof accessTable.$inferSelect;
type AccessWrite = typeof accessTable.$inferInsert;
type Json = Record<string, unknown>;

export type LedgerAcceptance = {
  provider: string;
  version: string;
  digest: string;
  /** The ledger event's occurred_at. */
  acceptedAt: string;
  eventId: string | null;
  /** The Firecrawl API key id (api_keys.id) that accepted, as text. */
  apiKeyId: string | null;
  actorType: string | null;
  /** A dashboard (human) acceptance without a key names its user. */
  actorUserId?: string | null;
  surface?: string | null;
  agent?: unknown;
};

type CurrentTerms = { key: string; version: string; digest: string };

type AcceptanceActor = {
  userId: string | null;
  actorType: "human" | "agent";
  basis: "admin" | "organization_election";
};

type AccessPlan =
  | { action: "insert" | "update"; values: AccessWrite }
  | { action: "noop"; reason: "already_recorded" | "record_is_newer" }
  | { action: "blocked"; reason: string };

export type MirrorOutcome =
  | { outcome: "written"; action: "insert" | "update" }
  | { outcome: "would_write"; action: "insert" | "update" }
  | { outcome: "noop"; reason: string }
  | { outcome: "blocked"; reason: string }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string };

const timestamp = (value: unknown): number =>
  typeof value === "string" ? Date.parse(value) : NaN;

/**
 * Decides what a ledger acceptance does to the stored row. Pure; see the
 * module comment for where each rule comes from.
 *
 * Never enabled: a suspended row, and a disabled row for any reason but the
 * org admin's own revocation (staff revocation, the admin's on/off switch
 * `disabled_by_organization_admin`, anything unknown). An org admin's
 * revocation is lifted only by an acceptance newer than the revocation, which
 * is what `authorizeProviders` already lets through.
 */
export function planAccessRecord(input: {
  orgId: string;
  row: AccessRow | null;
  terms: CurrentTerms;
  acceptance: LedgerAcceptance;
  actor: AcceptanceActor;
}): AccessPlan {
  const { orgId, row, terms, acceptance, actor } = input;
  const acceptedAt = timestamp(acceptance.acceptedAt);
  if (!Number.isFinite(acceptedAt))
    return { action: "blocked", reason: "invalid_acceptance_time" };
  if (
    acceptance.version !== terms.version ||
    acceptance.digest !== terms.digest
  )
    return { action: "blocked", reason: "stale_acceptance" };

  if (row) {
    if (row.status === "suspended")
      return { action: "blocked", reason: "suspended" };
    if (row.status !== "enabled") {
      const lifted =
        row.status === "disabled" &&
        row.disabled_reason === OWNER_REVOCATION &&
        Number.isFinite(timestamp(row.disabled_at)) &&
        acceptedAt > timestamp(row.disabled_at);
      if (!lifted)
        return {
          action: "blocked",
          reason: row.disabled_reason ?? `status_${row.status}`,
        };
    } else {
      const settings = (row.settings ?? {}) as Json;
      if (
        row.terms_key === terms.key &&
        row.terms_version === acceptance.version &&
        settings.terms_digest === acceptance.digest
      )
        return { action: "noop", reason: "already_recorded" };
      if (acceptedAt <= timestamp(row.terms_accepted_at))
        return { action: "noop", reason: "record_is_newer" };
    }
  }

  const settings = (row?.settings ?? {}) as Json;
  const receipt = {
    id: randomUUID(),
    eventId: acceptance.eventId,
    source: "exchange_ledger",
    orgId,
    acceptedBy: actor.userId,
    actorType: actor.actorType,
    basis: actor.basis,
    channel: acceptance.surface ?? "api",
    confirmation: "confirmed_option",
    ...(acceptance.apiKeyId ? { apiKeyId: acceptance.apiKeyId } : {}),
    ...(acceptance.agent ? { agent: acceptance.agent } : {}),
    acceptedAt: acceptance.acceptedAt,
    provider: acceptance.provider,
    providers: [
      {
        provider: acceptance.provider,
        version: acceptance.version,
        digest: acceptance.digest,
      },
    ],
    terms: {
      key: terms.key,
      version: acceptance.version,
      digest: acceptance.digest,
    },
  };
  const history = Array.isArray(row?.terms_acceptance_history)
    ? (row!.terms_acceptance_history as unknown[])
    : [];
  const values: AccessWrite = {
    org_id: orgId,
    data_source_id: acceptance.provider,
    terms_key: terms.key,
    terms_version: acceptance.version,
    terms_accepted_at: acceptance.acceptedAt,
    terms_accepted_by: actor.userId,
    terms_acceptance_history: [
      ...history,
      ...(row && !settings.terms_receipt
        ? [
            {
              terms_key: row.terms_key,
              terms_version: row.terms_version,
              accepted_at: row.terms_accepted_at,
              accepted_by: row.terms_accepted_by,
              digest: settings.terms_digest ?? null,
            },
          ]
        : []),
      receipt,
    ],
    settings: {
      ...settings,
      terms_digest: acceptance.digest,
      terms_receipt: receipt,
    },
    status: "enabled",
    enabled_at: acceptance.acceptedAt,
    enabled_by: actor.userId,
    disabled_at: null,
    disabled_by: null,
    disabled_reason: null,
  };
  return { action: row ? "update" : "insert", values };
}

const requirementsSchema = z.object({
  providers: z.array(
    z.object({
      provider: z.string(),
      required: z.boolean(),
      terms: z
        .object({ key: z.string(), version: z.string(), digest: z.string() })
        .passthrough()
        .nullable(),
    }),
  ),
});

/** The gating terms the Exchange asks for now, by provider. */
export async function currentTerms(
  teamId: string,
  providers: string[],
): Promise<Map<string, CurrentTerms> | null> {
  const found = new Map<string, CurrentTerms>();
  for (let i = 0; i < providers.length; i += 10) {
    const response = await exchangeRequest({
      teamId,
      path: "/v1/provider-terms/requirements",
      body: { providers: providers.slice(i, i + 10) },
      timeoutMs: EXCHANGE_TIMEOUT_MS,
    }).catch(() => undefined);
    const parsed =
      response?.status === 200
        ? requirementsSchema.safeParse(response.body)
        : undefined;
    if (!parsed?.success) return null;
    for (const item of parsed.data.providers)
      if (item.required && item.terms)
        found.set(item.provider, {
          key: item.terms.key,
          version: item.terms.version,
          digest: item.terms.digest,
        });
  }
  return found;
}

const statusSchema = z.object({
  agentAcceptance: z.object({ enabled: z.boolean() }).passthrough(),
});

/** Whether the organization currently allows agent acceptance (fails closed). */
async function agentAcceptanceElected(
  teamId: string,
  orgId: string,
): Promise<boolean> {
  const response = await exchangeRequest({
    teamId,
    path: `/v1/provider-terms/status?organizationId=${encodeURIComponent(orgId)}`,
    timeoutMs: EXCHANGE_TIMEOUT_MS,
  }).catch(() => undefined);
  const parsed =
    response?.status === 200
      ? statusSchema.safeParse(response.body)
      : undefined;
  return parsed?.success === true && parsed.data.agentAcceptance.enabled;
}

/**
 * Who, by the dashboard's rule, this acceptance speaks for. An API key accepts
 * as its owner when the owner is an admin of the key's team; any other key of
 * the organization only while the organization allows agent acceptance. A
 * keyless acceptance (a dashboard event) needs a user who is an admin of one
 * of the organization's teams. Anything unverifiable is null: not authorized.
 */
export async function acceptanceActor(input: {
  orgId: string;
  acceptance: Pick<LedgerAcceptance, "apiKeyId" | "actorType" | "actorUserId">;
  electionEnabled: () => Promise<boolean>;
}): Promise<AcceptanceActor | null> {
  const { orgId, acceptance } = input;
  if (acceptance.apiKeyId) {
    if (!/^\d{1,19}$/.test(acceptance.apiKeyId)) return null;
    const [key] = await db
      .select({
        owner: api_keys.owner_id,
        team: api_keys.team_id,
        org: teams.org_id,
      })
      .from(api_keys)
      .innerJoin(teams, eq(teams.id, api_keys.team_id))
      .where(sql`${api_keys.id} = ${acceptance.apiKeyId}::bigint`)
      .limit(1);
    if (!key || key.org !== orgId) return null;
    const [membership] = key.owner
      ? await db
          .select({ role: user_teams.role })
          .from(user_teams)
          .where(
            and(
              eq(user_teams.user_id, key.owner),
              eq(user_teams.team_id, key.team!),
            ),
          )
          .limit(1)
      : [];
    if (membership?.role === "admin")
      return { userId: key.owner, actorType: "human", basis: "admin" };
    if (await input.electionEnabled())
      return {
        userId: key.owner ?? null,
        actorType: "agent",
        basis: "organization_election",
      };
    return null;
  }
  if (acceptance.actorType === "human" && acceptance.actorUserId) {
    const [admin] = await db
      .select({ role: user_teams.role })
      .from(user_teams)
      .innerJoin(teams, eq(teams.id, user_teams.team_id))
      .where(
        and(
          eq(user_teams.user_id, acceptance.actorUserId),
          eq(teams.org_id, orgId),
          eq(user_teams.role, "admin"),
        ),
      )
      .limit(1);
    if (admin)
      return {
        userId: acceptance.actorUserId,
        actorType: "human",
        basis: "admin",
      };
  }
  return null;
}

async function readRow(orgId: string, provider: string) {
  const [row] = await db
    .select()
    .from(accessTable)
    .where(
      and(
        eq(accessTable.org_id, orgId),
        eq(accessTable.data_source_id, provider),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Writes a plan with the dashboard's optimistic concurrency: an insert that
 * finds a row, or an update whose `updated_at` moved, wrote nothing (false).
 */
async function writePlan(
  plan: Extract<AccessPlan, { action: "insert" | "update" }>,
  row: AccessRow | null,
): Promise<boolean> {
  if (plan.action === "insert") {
    const inserted = await db
      .insert(accessTable)
      .values(plan.values)
      .onConflictDoNothing()
      .returning({ id: accessTable.data_source_id });
    return inserted.length > 0;
  }
  const { org_id, data_source_id, ...changes } = plan.values;
  const updated = await db
    .update(accessTable)
    .set(changes)
    .where(
      and(
        eq(accessTable.org_id, org_id),
        eq(accessTable.data_source_id, data_source_id),
        eq(accessTable.updated_at, row!.updated_at),
      ),
    )
    .returning({ id: accessTable.data_source_id });
  return updated.length > 0;
}

/** Clears the auth chunk of every team of the organization. */
export async function refreshOrganizationAccessCache(orgId: string) {
  const orgTeams = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.org_id, orgId));
  await Promise.all(orgTeams.map(team => clearACUCForTeam(team.id)));
}

/**
 * Plans and writes one acceptance, re-reading on a concurrent change. Throws
 * on a database error; `mirrorLedgerAcceptance` owns the failure policy.
 */
export async function applyLedgerAcceptance(input: {
  orgId: string;
  terms: CurrentTerms;
  acceptance: LedgerAcceptance;
  actor: AcceptanceActor;
  dryRun?: boolean;
}): Promise<MirrorOutcome> {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    const row = await readRow(input.orgId, input.acceptance.provider);
    const plan = planAccessRecord({ ...input, row });
    if (plan.action === "noop" || plan.action === "blocked")
      return { outcome: plan.action, reason: plan.reason };
    if (input.dryRun) return { outcome: "would_write", action: plan.action };
    if (await writePlan(plan, row))
      return { outcome: "written", action: plan.action };
  }
  return { outcome: "failed", reason: "concurrent_changes" };
}

/**
 * Called right after the ledger accepted. Resolves the current terms (unless
 * given) and the acceptance's authority, writes the row, and clears the auth
 * cache so the next request sees it. Never throws.
 */
export async function mirrorLedgerAcceptance(input: {
  teamId: string;
  orgId: string;
  acceptance: LedgerAcceptance;
  termsKey?: string;
}): Promise<MirrorOutcome> {
  const { teamId, orgId, acceptance } = input;
  const logger = rootLogger.child({
    module: "alexandria/access-record",
    teamId,
    orgId,
    provider: acceptance.provider,
    ledgerEventId: acceptance.eventId,
  });
  try {
    let terms: CurrentTerms | undefined = input.termsKey
      ? {
          key: input.termsKey,
          version: acceptance.version,
          digest: acceptance.digest,
        }
      : undefined;
    if (!terms) {
      const current = await currentTerms(teamId, [acceptance.provider]);
      if (!current) throw new Error("Provider requirements are unavailable");
      terms = current.get(acceptance.provider);
      if (!terms) return { outcome: "skipped", reason: "no_terms_required" };
    }
    const actor = await acceptanceActor({
      orgId,
      acceptance,
      electionEnabled: () => agentAcceptanceElected(teamId, orgId),
    });
    if (!actor) {
      // The ledger path accepts with any key of the organization; the
      // dashboard only with an admin's own key or under the organization's
      // election. The row follows the dashboard's rule and is not written.
      logger.warn(
        "Provider terms accepted in the ledger by a key the dashboard would not let accept; access record not written",
        { apiKeyId: acceptance.apiKeyId },
      );
      return { outcome: "skipped", reason: "not_authorized" };
    }
    let outcome: MirrorOutcome | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS && !outcome; attempt++) {
      try {
        outcome = await applyLedgerAcceptance({
          orgId,
          terms,
          acceptance,
          actor,
        });
      } catch (error) {
        lastError = error;
        if (attempt < WRITE_ATTEMPTS)
          await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
    if (!outcome) throw lastError;
    if (outcome.outcome === "failed") throw new Error(outcome.reason);
    if (outcome.outcome === "blocked")
      logger.info("Provider access record left as is after terms acceptance", {
        reason: outcome.reason,
      });
    if (outcome.outcome === "written") {
      await refreshOrganizationAccessCache(orgId).catch(error =>
        logger.error(
          "Provider access record written but the auth cache was not cleared; it refreshes within 10 minutes",
          { error },
        ),
      );
    }
    return outcome;
  } catch (error) {
    logger.error(
      "Provider terms were accepted in the ledger but the organization access record was not written; the API still honours the ledger. Re-run the provider-access backfill for this organization.",
      { error, apiKeyId: acceptance.apiKeyId },
    );
    return {
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
