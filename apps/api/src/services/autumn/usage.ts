import { eq, inArray } from "drizzle-orm";
import { dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { logger } from "../../lib/logger";
import { getValue, setValue } from "../redis";
import { autumnClient, autumnHistoricalClient } from "./client";
import { CREDITS_FEATURE_ID } from "./autumn.service";

export const TOKENS_PER_CREDIT = 15;
const HISTORICAL_BIN_SIZE = "day";

// The reported window starts at the beginning of the calendar month containing
// (now - HISTORICAL_MIN_DAYS), so it always covers at least as much history as
// the previous rolling `range: "90d"` did, and never less on the 1st of a
// month. Snapping to a month boundary is what makes the rollup cacheable: a
// window that shifts every day makes every month look mutable. It also fixes
// under-reporting at the old window's edge, where a 90d span opened mid-month
// (e.g. May counted from May 2) but was still labelled as the whole month.
const HISTORICAL_MIN_DAYS = 90;

// Autumn caps the number of distinct `groupBy` values per bin and buckets the
// rest into an overflow group (default 9). Teams routinely have more API keys
// than that, and with per-day bins the top-9 differs day to day, so the default
// silently scrambles per-key monthly totals. Ask for a ceiling no real team
// reaches.
const HISTORICAL_MAX_GROUPS = 250;

// Autumn's label for the bucket holding every group beyond `maxGroups`. Its
// credits are real but can no longer be attributed to individual keys, so it is
// surfaced under its own name rather than folded into "Unknown" (which means
// "this ID did not resolve to a key") — those are different facts and a caller
// reconciling per-key totals needs to tell them apart. API key IDs are numeric,
// so this can never collide with a real one.
const AUTUMN_OVERFLOW_GROUP = "Other";

// Bump when the cached payload shape changes, so old entries are ignored
// rather than misread.
const ROLLUP_CACHE_VERSION = "v1";

// Today is still accruing usage, so its slice is only cached briefly — new
// charges show up in the endpoint within this window.
const TODAY_TTL_SECONDS = 60;

// Elapsed days of the current month can no longer change, but the slice covers
// a growing number of days, so it is re-keyed (not just re-read) each day.
const MONTH_TO_DATE_TTL_SECONDS = 2 * 24 * 60 * 60;

// Closed months can never change. The key names the month, so this TTL only
// reclaims space once the month leaves the reported window.
const CLOSED_MONTHS_MAX_TTL_SECONDS = 40 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamBalance {
  remaining: number;
  planCredits: number;
  usage: number;
  unlimited: boolean;
  periodStart: string | null;
  periodEnd: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function lookupOrgId(teamId: string): Promise<string> {
  const [data] = await dbRr
    .select({ org_id: schema.teams.org_id })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId))
    .limit(1);

  if (!data?.org_id) {
    throw new Error(`Missing org_id for team ${teamId}`);
  }
  return data.org_id;
}

/**
 * Maps API key identifiers from Autumn events to their display names.
 *
 * Autumn returns whatever value was sent as `properties.apiKeyId`. Current
 * code sends the numeric `api_keys.id`, but the 90-day aggregation window can
 * still include legacy events tagged with opaque non-numeric values. Anything
 * we can't resolve is labeled "Unknown" so the response never surfaces raw
 * identifiers.
 */
async function lookupApiKeyNames(
  apiKeyIds: string[],
): Promise<Record<string, string>> {
  const numericIds = apiKeyIds
    .map(id => Number(id))
    .filter(n => Number.isInteger(n) && n > 0);

  // Prototype-free: group values come from Autumn, so an id like "constructor"
  // must not resolve to an inherited property instead of a name.
  const nameMap: Record<string, string> = Object.create(null);

  if (numericIds.length > 0) {
    const rows = await dbRr
      .select({ id: schema.api_keys.id, name: schema.api_keys.name })
      .from(schema.api_keys)
      .where(inArray(schema.api_keys.id, numericIds));

    for (const row of rows) {
      nameMap[String(row.id)] = row.name ?? "Unknown";
    }
  }

  for (const id of apiKeyIds) {
    if (nameMap[id]) continue;
    nameMap[id] =
      id === AUTUMN_OVERFLOW_GROUP ? "Other (unattributed)" : "Unknown";
  }

  return nameMap;
}

function toMonthStartIso(period: unknown): string | null {
  if (period == null) return null;

  const date = new Date(period as string | number);
  if (isNaN(date.getTime())) return null;

  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
  ).toISOString();
}

function nextMonthIso(monthStartIso: string): string {
  const date = new Date(monthStartIso);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  ).toISOString();
}

/**
 * Per-month credit totals, keyed by the month's UTC start as an ISO string.
 * This is the cached rollup shape for the ungrouped endpoints.
 */
type MonthTotals = Record<string, number>;

/**
 * Per-month, per-API-key credit totals. Keyed by raw `apiKeyId` rather than
 * display name so renaming a key is reflected immediately instead of being
 * frozen into a cache entry for the rest of the month.
 */
type MonthApiKeyTotals = Record<string, Record<string, number>>;

function sumByMonth(list: any[]): MonthTotals {
  const totals: MonthTotals = Object.create(null);

  for (const entry of list) {
    const monthStart = toMonthStartIso(entry.period);
    if (!monthStart) continue;

    totals[monthStart] =
      (totals[monthStart] ?? 0) + (entry.values?.[CREDITS_FEATURE_ID] ?? 0);
  }

  return totals;
}

function getGroupedCredits(entry: any): Record<string, number> | undefined {
  return (
    entry.groupedValues?.[CREDITS_FEATURE_ID] ??
    entry.grouped_values?.[CREDITS_FEATURE_ID]
  );
}

function sumByMonthAndApiKey(list: any[]): MonthApiKeyTotals {
  const totals: MonthApiKeyTotals = Object.create(null);

  for (const entry of list) {
    const monthStart = toMonthStartIso(entry.period);
    if (!monthStart) continue;

    const grouped = getGroupedCredits(entry);
    if (!grouped) continue;

    const monthTotals = totals[monthStart] ?? Object.create(null);

    for (const [apiKeyId, creditsUsed] of Object.entries(grouped)) {
      monthTotals[apiKeyId] = (monthTotals[apiKeyId] ?? 0) + creditsUsed;
    }

    totals[monthStart] = monthTotals;
  }

  return totals;
}

/** Merges rollup slices (closed months + current month) into one map. */
function mergeMonthTotals(slices: MonthTotals[]): MonthTotals {
  const merged: MonthTotals = Object.create(null);
  for (const slice of slices) {
    for (const [month, credits] of Object.entries(slice)) {
      merged[month] = (merged[month] ?? 0) + credits;
    }
  }
  return merged;
}

function mergeMonthApiKeyTotals(
  slices: MonthApiKeyTotals[],
): MonthApiKeyTotals {
  const merged: MonthApiKeyTotals = Object.create(null);
  for (const slice of slices) {
    for (const [month, byKey] of Object.entries(slice)) {
      const target = merged[month] ?? Object.create(null);
      for (const [apiKeyId, credits] of Object.entries(byKey)) {
        target[apiKeyId] = (target[apiKeyId] ?? 0) + credits;
      }
      merged[month] = target;
    }
  }
  return merged;
}

function toHistoricalPeriods(totals: MonthTotals): HistoricalPeriod[] {
  const monthStarts = Object.keys(totals).sort();

  return monthStarts.map((startDate, i) => ({
    startDate,
    endDate: i < monthStarts.length - 1 ? nextMonthIso(startDate) : null,
    creditsUsed: totals[startDate] ?? 0,
  }));
}

async function toHistoricalPeriodsByApiKey(
  totals: MonthApiKeyTotals,
): Promise<HistoricalPeriodByApiKey[]> {
  const allApiKeyIds = new Set<string>();
  for (const byKey of Object.values(totals)) {
    for (const apiKeyId of Object.keys(byKey)) allApiKeyIds.add(apiKeyId);
  }

  const nameMap = await lookupApiKeyNames([...allApiKeyIds]);
  const monthStarts = Object.keys(totals).sort();
  const results: HistoricalPeriodByApiKey[] = [];

  for (let i = 0; i < monthStarts.length; i++) {
    const startDate = monthStarts[i];
    const endDate = i < monthStarts.length - 1 ? nextMonthIso(startDate) : null;
    const monthTotals = totals[startDate];

    if (!monthTotals) continue;

    // Collapse rows whose IDs resolve to the same display name (e.g. multiple
    // unresolved IDs all show as "Unknown") so the response has one row per
    // name per month.
    const byName = new Map<string, number>();
    for (const [apiKeyId, creditsUsed] of Object.entries(monthTotals)) {
      const name = nameMap[apiKeyId];
      byName.set(name, (byName.get(name) ?? 0) + creditsUsed);
    }

    for (const [apiKey, creditsUsed] of [...byName.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      results.push({
        startDate,
        endDate,
        apiKey,
        creditsUsed,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Balance (current billing period)
// ---------------------------------------------------------------------------

/**
 * Fetches a team's credit balance and billing period from Autumn.
 *
 * Tries entity-scoped balance first (team as entity under org customer),
 * then falls back to customer-level balance.
 */
export async function getTeamBalance(
  teamId: string,
): Promise<TeamBalance | null> {
  if (!autumnClient) {
    throw new Error(
      "Autumn client is not configured (AUTUMN_SECRET_KEY missing)",
    );
  }

  const orgId = await lookupOrgId(teamId);

  // Try entity-scoped balance first
  let balances: Record<string, any> | undefined;
  let subscriptions: Array<any> | undefined;

  try {
    const entity = await autumnClient.entities.get({
      customerId: orgId,
      entityId: teamId,
    });
    balances = entity?.balances;
    subscriptions = entity?.subscriptions;
  } catch (err: any) {
    const status = err?.statusCode ?? err?.status ?? err?.response?.status;
    if (status !== 404) throw err;
    // Entity not found — fall through to customer-level
  }

  // Fall back to customer-level if CREDITS balance is missing, or if the
  // entity had no subscriptions (subscriptions live at the customer level
  // while balances may be entity-scoped).
  const needCustomerFallback =
    !balances?.[CREDITS_FEATURE_ID] || !subscriptions?.length;

  if (needCustomerFallback) {
    const customer = await autumnClient.customers.getOrCreate({
      customerId: orgId,
      autoEnablePlanId: "free",
    });

    if (!balances?.[CREDITS_FEATURE_ID]) {
      balances = customer?.balances;
    }
    // Always prefer customer-level subscriptions when entity had none
    if (!subscriptions?.length) {
      subscriptions = customer?.subscriptions;
    }
  }

  const creditBalance = balances?.[CREDITS_FEATURE_ID];

  if (!creditBalance) {
    return null;
  }

  // Find the subscription's billing period.
  // Autumn uses "active" and "scheduled" statuses (not Stripe's "trialing" /
  // "past_due").  Prefer an active subscription, but fall back to any
  // subscription that carries period timestamps so we never return nulls
  // when the data is actually available.
  const activeSub =
    subscriptions?.find((s: any) => s.status === "active") ??
    subscriptions?.find((s: any) => s.currentPeriodStart != null);

  let periodStartEpoch = activeSub?.currentPeriodStart;
  let periodEndEpoch = activeSub?.currentPeriodEnd;

  // Extract plan-only credits from the breakdown (excludes credit packs,
  // auto-recharge, one-off grants, etc.) to preserve backwards compatibility
  // with the old planCredits field semantics.
  let planCredits = creditBalance?.granted ?? 0;
  const breakdowns: Array<any> | undefined = creditBalance?.breakdown;

  // For yearly plans, Autumn may not populate currentPeriodStart/End on the
  // subscription.  Fall back to the balance's reset schedule: nextResetAt is
  // the period end, and we derive the start from the reset interval.
  if (periodStartEpoch == null && periodEndEpoch == null) {
    const resetAt: number | undefined = creditBalance?.nextResetAt;
    if (resetAt) {
      const resetEntry = breakdowns?.find(
        (b: any) => b.reset?.interval && b.reset.interval !== "one_off",
      );
      const interval = resetEntry?.reset?.interval;
      if (interval === "month" || interval === "year") {
        periodEndEpoch = resetAt;
        const endDate = new Date(resetAt);
        const targetYear =
          interval === "year"
            ? endDate.getUTCFullYear() - 1
            : endDate.getUTCFullYear();
        const targetMonth =
          interval === "month"
            ? endDate.getUTCMonth() - 1
            : endDate.getUTCMonth();

        // Clamp day to the last day of the target month to avoid overflow
        // (e.g. Mar 31 minus 1 month → Feb 28, not Mar 3)
        const lastDay = new Date(
          Date.UTC(targetYear, targetMonth + 1, 0),
        ).getUTCDate();
        const clampedDay = Math.min(endDate.getUTCDate(), lastDay);

        periodStartEpoch = new Date(
          Date.UTC(
            targetYear,
            targetMonth,
            clampedDay,
            endDate.getUTCHours(),
            endDate.getUTCMinutes(),
            endDate.getUTCSeconds(),
            endDate.getUTCMilliseconds(),
          ),
        ).getTime();
      }
    }
  }
  if (breakdowns?.length) {
    planCredits = breakdowns.reduce(
      (sum: number, b: any) =>
        b.planId != null ? sum + (b.includedGrant ?? 0) : sum,
      0,
    );
  }

  return {
    remaining: signedRemaining(creditBalance),
    planCredits,
    usage: creditBalance?.usage ?? 0,
    unlimited: creditBalance?.unlimited ?? false,
    periodStart: periodStartEpoch
      ? new Date(periodStartEpoch).toISOString()
      : null,
    periodEnd: periodEndEpoch ? new Date(periodEndEpoch).toISOString() : null,
  };
}

// Autumn caps `balance.remaining` at 0, so it can't surface negative balances
// for teams in overage. `granted - usage` preserves the signed balance.
function signedRemaining(
  balance:
    | {
        granted?: number;
        usage?: number;
        remaining?: number;
        unlimited?: boolean;
      }
    | undefined,
): number {
  if (!balance) return 0;
  if (balance.unlimited === true) return balance.remaining ?? 0;
  return (balance.granted ?? 0) - (balance.usage ?? 0);
}

// ---------------------------------------------------------------------------
// Historical usage (across billing periods)
// ---------------------------------------------------------------------------

interface HistoricalPeriod {
  startDate: string | null;
  endDate: string | null;
  creditsUsed: number;
}

interface HistoricalPeriodByApiKey {
  startDate: string | null;
  endDate: string | null;
  apiKey: string;
  creditsUsed: number;
}

// ---------------------------------------------------------------------------
// Rollup cache
// ---------------------------------------------------------------------------

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonthsUtc(date: Date, months: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
}

function startOfDayUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * One cacheable window of the reported history.
 *
 * The cache key encodes the window's own boundaries, so a stale entry can
 * never be served for a different window — correctness comes from the key, and
 * the TTL only reclaims space. When the day or month rolls over, the affected
 * slices simply get new keys.
 */
interface RollupSlice {
  key: string;
  ttlSeconds: number;
  start: Date;
  end: Date;
}

function sliceKey(teamId: string, grouped: boolean, suffix: string): string {
  return `usage-rollup:${ROLLUP_CACHE_VERSION}:${grouped ? "by-key" : "total"}:${teamId}:${suffix}`;
}

/**
 * Splits the reported history into windows ordered by how often each can
 * change, which is what keeps the recurring cost off the team's total event
 * volume:
 *
 *   - one window per closed calendar month — immutable, computed once ever
 *   - the current month up to midnight today — immutable, once per day
 *   - today so far — the only window re-queried during the day
 *
 * So the steady-state request scans a single day of events rather than ~90
 * days, and a fully cold cache costs one parallel query per window.
 */
function buildRollupSlices(
  teamId: string,
  grouped: boolean,
  now: Date,
): RollupSlice[] {
  const currentMonthStart = startOfMonthUtc(now);
  const todayStart = startOfDayUtc(now);
  const slices: RollupSlice[] = [];

  // Start at the month containing the oldest day the endpoint must still cover,
  // so the reported span is never shorter than HISTORICAL_MIN_DAYS — including
  // on the 1st of a month, when a fixed month count would fall short.
  const oldestRequiredDay = new Date(
    now.getTime() - HISTORICAL_MIN_DAYS * 24 * 60 * 60 * 1000,
  );

  for (
    let start = startOfMonthUtc(oldestRequiredDay);
    start.getTime() < currentMonthStart.getTime();
    start = addMonthsUtc(start, 1)
  ) {
    slices.push({
      key: sliceKey(teamId, grouped, `m:${isoMonth(start)}`),
      ttlSeconds: CLOSED_MONTHS_MAX_TTL_SECONDS,
      start,
      end: addMonthsUtc(start, 1),
    });
  }

  // Empty on the 1st of the month, when there is no elapsed-but-closed part.
  if (todayStart.getTime() > currentMonthStart.getTime()) {
    slices.push({
      key: sliceKey(
        teamId,
        grouped,
        `mtd:${isoMonth(currentMonthStart)}:${isoDay(todayStart)}`,
      ),
      ttlSeconds: MONTH_TO_DATE_TTL_SECONDS,
      start: currentMonthStart,
      end: todayStart,
    });
  }

  slices.push({
    key: sliceKey(teamId, grouped, `d:${isoDay(todayStart)}`),
    ttlSeconds: TODAY_TTL_SECONDS,
    start: todayStart,
    end: now,
  });

  return slices;
}

// Coalesces concurrent computations of the same key inside this process, so a
// burst of dashboard requests on a cold cache produces one Autumn call rather
// than one per request.
const inFlightRollups = new Map<string, Promise<unknown>>();

/**
 * Reads a rollup slice from Redis, computing and caching it on a miss.
 *
 * Cache faults are never fatal: a Redis outage degrades to querying Autumn
 * directly, which is the pre-cache behaviour.
 */
async function cachedRollup<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  try {
    const cached = await getValue(key);
    if (cached !== null) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as T;
      }
      logger.warn("Ignoring malformed usage rollup cache entry", { key });
    }
  } catch (error) {
    logger.warn("Failed to read usage rollup cache", { key, error });
  }

  const existing = inFlightRollups.get(key);
  if (existing) return existing as Promise<T>;

  const pending = (async () => {
    const value = await compute();
    try {
      await setValue(key, JSON.stringify(value), ttlSeconds);
    } catch (error) {
      logger.warn("Failed to cache usage rollup", { key, error });
    }
    return value;
  })();

  inFlightRollups.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlightRollups.delete(key);
  }
}

/**
 * Runs one `events.aggregate` over an explicit half-open [start, end) window.
 *
 * Returns the raw bin list, or `null` when the team has no Autumn entity (a
 * team that was never provisioned has no usage of its own to report, and we
 * must not fall back to the org total).
 */
async function aggregateWindow(opts: {
  client: NonNullable<typeof autumnHistoricalClient>;
  orgId: string;
  teamId: string;
  start: Date;
  end: Date;
  grouped: boolean;
}): Promise<any[] | null> {
  try {
    const response = await opts.client.events.aggregate({
      customerId: opts.orgId,
      entityId: opts.teamId,
      featureId: CREDITS_FEATURE_ID,
      customRange: { start: opts.start.getTime(), end: opts.end.getTime() },
      binSize: HISTORICAL_BIN_SIZE,
      ...(opts.grouped
        ? {
            groupBy: "properties.apiKeyId",
            maxGroups: HISTORICAL_MAX_GROUPS,
          }
        : {}),
    });
    return response.list ?? [];
  } catch (err: any) {
    const status = err?.statusCode ?? err?.status ?? err?.response?.status;
    if (status !== 404) throw err;
    // Entity not found — the team has no usage of its own to report.
    return null;
  }
}

/**
 * Builds a team's per-month credit rollup over the reported window.
 *
 * Every slice from buildRollupSlices is fetched (or served from cache) in
 * parallel and summed. That is what keeps this endpoint's cost off the team's
 * total event volume: previously every request made Autumn walk ~90 days of raw
 * events, and the `byApiKey=true` variant did so per group per daily bin, which
 * is why high-volume teams timed out. Now only today's slice is re-queried
 * during a day.
 */
async function getMonthlyRollup<T extends MonthTotals | MonthApiKeyTotals>(
  teamId: string,
  grouped: boolean,
  summarize: (list: any[]) => T,
  merge: (slices: T[]) => T,
): Promise<T> {
  const client = autumnHistoricalClient;
  if (!client) {
    throw new Error(
      "Autumn client is not configured (AUTUMN_SECRET_KEY missing)",
    );
  }

  const orgId = await lookupOrgId(teamId);
  const empty = merge([]);

  // A missing entity is cached as an empty slice on purpose: a team with no
  // Autumn entity had no usage in those windows either, and once it is
  // provisioned its usage lands in today's slice, which refreshes within a
  // minute.
  const fetchSlice = async (slice: RollupSlice): Promise<T> => {
    if (slice.end.getTime() <= slice.start.getTime()) return empty;
    const list = await aggregateWindow({
      client,
      orgId,
      teamId,
      start: slice.start,
      end: slice.end,
      grouped,
    });
    return list === null ? empty : summarize(list);
  };

  const results = await Promise.all(
    buildRollupSlices(teamId, grouped, new Date()).map(slice =>
      cachedRollup(slice.key, slice.ttlSeconds, () => fetchSlice(slice)),
    ),
  );

  return merge(results);
}

/**
 * Fetches a team's historical credit usage by calendar month.
 *
 * Scopes the aggregate to the team's Autumn entity so the response reflects
 * only that team's usage, not the whole org, and serves it from a cached
 * per-month rollup (see getMonthlyRollup). A team with no entity (never
 * provisioned) has no team-scoped usage, so we return an empty history rather
 * than the org total.
 */
export async function getTeamHistoricalUsage(
  teamId: string,
): Promise<HistoricalPeriod[]> {
  const totals = await getMonthlyRollup<MonthTotals>(
    teamId,
    false,
    sumByMonth,
    mergeMonthTotals,
  );
  return toHistoricalPeriods(totals);
}

/**
 * Fetches a team's historical credit usage by calendar month, broken down per
 * API key. Served from the same cached rollup as the ungrouped variant.
 */
export async function getTeamHistoricalUsageByApiKey(
  teamId: string,
): Promise<HistoricalPeriodByApiKey[]> {
  const totals = await getMonthlyRollup<MonthApiKeyTotals>(
    teamId,
    true,
    sumByMonthAndApiKey,
    mergeMonthApiKeyTotals,
  );
  return toHistoricalPeriodsByApiKey(totals);
}

/**
 * Converts historical credit periods to token periods.
 * Tokens = credits × 15.
 */
export function toTokenPeriods(
  periods: HistoricalPeriod[],
): { startDate: string | null; endDate: string | null; tokensUsed: number }[] {
  return periods.map(p => ({
    startDate: p.startDate,
    endDate: p.endDate,
    tokensUsed: p.creditsUsed * TOKENS_PER_CREDIT,
  }));
}

/**
 * Converts historical credit periods (by API key) to token periods.
 * Tokens = credits × 15.
 */
export function toTokenPeriodsByApiKey(periods: HistoricalPeriodByApiKey[]): {
  startDate: string | null;
  endDate: string | null;
  apiKey: string;
  tokensUsed: number;
}[] {
  return periods.map(p => ({
    startDate: p.startDate,
    endDate: p.endDate,
    apiKey: p.apiKey,
    tokensUsed: p.creditsUsed * TOKENS_PER_CREDIT,
  }));
}
