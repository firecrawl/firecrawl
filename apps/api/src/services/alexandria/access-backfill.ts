import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/connection";
import { teams } from "../../db/schema";
import { logger as rootLogger } from "../../lib/logger";
import {
  acceptanceActor,
  applyLedgerAcceptance,
  currentTerms,
  refreshOrganizationAccessCache,
  type LedgerAcceptance,
  type MirrorOutcome,
} from "./access-record";
import { exchangeRequest } from "./client";

/**
 * One-off: derive `organization_data_source_access` rows for acceptances that
 * exist only in the Exchange ledger (made through `terms/accept` before the API
 * mirrored them). Same rules as the live mirror (`access-record.ts`): only the
 * latest, unrevoked acceptance of the current terms; never enables a
 * suspended or staff/admin-disabled row; lifts an org admin's revocation only
 * with a later acceptance; follows the dashboard's rule for who may accept,
 * with the organization's agent-acceptance election read as it stood when
 * the acceptance was made. Idempotent: a second run finds every row current.
 * Dry run by default.
 */

const EXCHANGE_TIMEOUT_MS = 10_000;
const PAGE = 200;
const MAX_PAGES = 25;

const eventSchema = z
  .object({
    id: z.string(),
    dataSourceId: z.string().nullable(),
    eventType: z.string(),
    version: z.string().nullable(),
    textHash: z.string().nullable(),
    actorType: z.string().nullable().optional(),
    actorUserId: z.string().nullable().optional(),
    credentialId: z.string().nullable().optional(),
    surface: z.string().nullable().optional(),
    agentDescriptor: z.unknown().optional(),
    occurredAt: z.string(),
  })
  .passthrough();
type LedgerEvent = z.infer<typeof eventSchema>;
const pageSchema = z.object({
  events: z.array(eventSchema),
  nextCursor: z.string().nullable().optional(),
});

/** Every ledger event of the organization, newest first. */
async function ledgerEvents(
  teamId: string,
  orgId: string,
): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({
      organizationId: orgId,
      limit: String(PAGE),
      ...(cursor ? { cursor } : {}),
    });
    const response = await exchangeRequest({
      teamId,
      path: `/v1/provider-terms/events?${query}`,
      timeoutMs: EXCHANGE_TIMEOUT_MS,
    });
    const parsed =
      response.status === 200 ? pageSchema.safeParse(response.body) : null;
    if (!parsed?.success)
      throw new Error(`Terms ledger answered ${response.status}`);
    events.push(...parsed.data.events);
    cursor = parsed.data.nextCursor;
    if (!cursor) return events;
  }
  throw new Error("Terms ledger has more events than the backfill reads");
}

const ACCEPTED = new Set(["accepted", "reaccepted"]);
const REVOKED = new Set(["revoked", "staff_revoked"]);

/** Per provider, the latest acceptance unless a revocation came after it. */
function latestAcceptances(events: LedgerEvent[]) {
  const latest = new Map<string, LedgerEvent>();
  for (const event of events) {
    if (!event.dataSourceId || latest.has(event.dataSourceId)) continue;
    if (ACCEPTED.has(event.eventType) || REVOKED.has(event.eventType))
      latest.set(event.dataSourceId, event);
  }
  return [...latest.values()];
}

function electedAt(events: LedgerEvent[], at: string): boolean {
  const when = Date.parse(at);
  const election = events.find(
    event =>
      (event.eventType === "election_enabled" ||
        event.eventType === "election_disabled") &&
      Date.parse(event.occurredAt) <= when,
  );
  return election?.eventType === "election_enabled";
}

type BackfillResult = {
  orgId: string;
  provider: string | null;
} & (MirrorOutcome | { outcome: "error"; reason: string });

export async function backfillProviderAccess(input: {
  orgIds: string[];
  dryRun: boolean;
}): Promise<{ dryRun: boolean; results: BackfillResult[] }> {
  const logger = rootLogger.child({
    module: "alexandria/access-backfill",
    dryRun: input.dryRun,
  });
  const results: BackfillResult[] = [];
  for (const orgId of input.orgIds) {
    try {
      const [team] = await db
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.org_id, orgId))
        .limit(1);
      if (!team) {
        results.push({
          orgId,
          provider: null,
          outcome: "skipped",
          reason: "no_team",
        });
        continue;
      }
      const events = await ledgerEvents(team.id, orgId);
      const latest = latestAcceptances(events);
      if (latest.length === 0) continue;
      const terms = await currentTerms(
        team.id,
        latest.map(event => event.dataSourceId!),
      );
      if (!terms) throw new Error("Provider requirements are unavailable");
      let wrote = false;
      for (const event of latest) {
        const provider = event.dataSourceId!;
        const push = (outcome: MirrorOutcome) =>
          results.push({ orgId, provider, ...outcome });
        if (REVOKED.has(event.eventType)) {
          push({ outcome: "skipped", reason: "ledger_revoked" });
          continue;
        }
        const current = terms.get(provider);
        if (!current) {
          push({ outcome: "skipped", reason: "no_terms_required" });
          continue;
        }
        if (!event.version || !event.textHash) {
          push({ outcome: "skipped", reason: "incomplete_ledger_event" });
          continue;
        }
        const acceptance: LedgerAcceptance = {
          provider,
          version: event.version,
          digest: event.textHash,
          acceptedAt: event.occurredAt,
          eventId: event.id,
          apiKeyId: event.credentialId ?? null,
          actorType: event.actorType ?? null,
          actorUserId: event.actorUserId ?? null,
          surface: event.surface ?? null,
          agent: event.agentDescriptor ?? undefined,
        };
        const actor = await acceptanceActor({
          orgId,
          acceptance,
          electionEnabled: async () => electedAt(events, event.occurredAt),
        });
        if (!actor) {
          push({ outcome: "skipped", reason: "not_authorized" });
          continue;
        }
        const outcome = await applyLedgerAcceptance({
          orgId,
          terms: current,
          acceptance,
          actor,
          dryRun: input.dryRun,
        });
        if (outcome.outcome === "written") wrote = true;
        push(outcome);
      }
      if (wrote) await refreshOrganizationAccessCache(orgId);
    } catch (error) {
      logger.error("Provider access backfill failed for organization", {
        orgId,
        error,
      });
      results.push({
        orgId,
        provider: null,
        outcome: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { dryRun: input.dryRun, results };
}
