import { logger } from "../../lib/logger";
import { eq, inArray } from "drizzle-orm";
import { dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { getValue, setValue } from "../redis";
import { autumnClient } from "./client";
import {
  CREDITS_FEATURE_ID,
  SEARCH_CREDITS_FEATURE_ID,
} from "./autumn.service";

export const TOKENS_PER_CREDIT = 15;
const HISTORICAL_RANGE = "90d";
const HISTORICAL_BIN_SIZE = "day";
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORICAL_WINDOW_MS = 90 * DAY_MS;

// The historical/analytics aggregations below are bucketed by day (and
// optionally grouped by API key or endpoint), so Autumn has to walk raw events
// and their cost scales with the team's event volume. That routinely takes
// several seconds. The Autumn client's global 2s timeout is sized for the
// latency-sensitive balance checks on the request hot path, and it is far too
// tight here, so these calls override it per call.
const HISTORICAL_AGGREGATE_TIMEOUT_MS = 15000;

// Grouping over the whole 90-day window does not finish inside that timeout
// for teams with tens of millions of events in it, so the grouped breakdowns
// (byApiKey, byEndpoint) ask Autumn for fixed 7-day slices instead. A slice
// that ended over a day ago no longer changes and is cached for as long as it
// can still fall inside the window, so a warm request only asks Autumn for the
// slice holding today (and, for a day after a slice boundary, the one before
// it).
const GROUPED_SLICE_MS = 7 * DAY_MS;
const GROUPED_SLICE_SETTLE_MS = DAY_MS;
const GROUPED_SLICE_CACHE_TTL_SECONDS = HISTORICAL_WINDOW_MS / 1000;
const GROUPED_SLICE_CONCURRENCY = 2;

// Autumn's maximum. Its default of 9 folds every further group into one
// "Other" group per day, which the response could not label.
const GROUPED_MAX_GROUPS = 250;

// Autumn limits event aggregates per customer per second, and a cold grouped
// request makes one call per slice. A rate-limited slice waits and retries;
// every other status fails the request as before.
const GROUPED_RATE_LIMIT_RETRY = {
  retries: {
    strategy: "backoff" as const,
    backoff: {
      initialInterval: 250,
      maxInterval: 1000,
      exponent: 2,
      maxElapsedTime: 3000,
    },
    retryConnectionErrors: false,
  },
  retryCodes: ["429"],
};

/** How a grouped breakdown asks Autumn for its days and caches them. */
interface UsageGrouping {
  groupBy: string;
  featureId: string | string[];
  cachePrefix: string;
}

const API_KEY_GROUPING: UsageGrouping = {
  groupBy: "properties.apiKeyId",
  featureId: CREDITS_FEATURE_ID,
  cachePrefix: "historical-usage-by-api-key:v1",
};

// Search usage is recorded against SEARCH_CREDITS, so the endpoint breakdown
// reads both features; without it search would be missing as an endpoint.
const ENDPOINT_GROUPING: UsageGrouping = {
  groupBy: "properties.endpoint",
  featureId: [CREDITS_FEATURE_ID, SEARCH_CREDITS_FEATURE_ID],
  cachePrefix: "historical-usage-by-endpoint:v1",
};

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

  const nameMap: Record<string, string> = {};

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
    if (!nameMap[id]) nameMap[id] = "Unknown";
  }

  return nameMap;
}

/** Width of a historical usage period. */
export type HistoricalBin = "month" | "day";

function toBinStartIso(period: unknown, bin: HistoricalBin): string | null {
  if (period == null) return null;

  const date = new Date(period as string | number);
  if (isNaN(date.getTime())) return null;

  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      bin === "day" ? date.getUTCDate() : 1,
    ),
  ).toISOString();
}

function nextBinIso(binStartIso: string, bin: HistoricalBin): string {
  const date = new Date(binStartIso);
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + (bin === "month" ? 1 : 0),
      date.getUTCDate() + (bin === "day" ? 1 : 0),
    ),
  ).toISOString();
}

function aggregateHistoricalPeriods(
  list: any[],
  bin: HistoricalBin,
): HistoricalPeriod[] {
  const binTotals = new Map<string, number>();

  for (const entry of list) {
    const binStart = toBinStartIso(entry.period, bin);
    if (!binStart) continue;

    binTotals.set(
      binStart,
      (binTotals.get(binStart) ?? 0) +
        (entry.values?.[CREDITS_FEATURE_ID] ?? 0),
    );
  }

  const binStarts = [...binTotals.keys()].sort();

  return binStarts.map((startDate, i) => ({
    startDate,
    endDate: i < binStarts.length - 1 ? nextBinIso(startDate, bin) : null,
    creditsUsed: binTotals.get(startDate) ?? 0,
  }));
}

/** Sums each group's credits across the grouping's features. */
function getGroupedCredits(
  entry: any,
  grouping: UsageGrouping,
): Record<string, number> | undefined {
  let credits: Record<string, number> | undefined;
  for (const featureId of [grouping.featureId].flat()) {
    const values: Record<string, number> | undefined =
      entry.groupedValues?.[featureId] ?? entry.grouped_values?.[featureId];
    if (!values) continue;

    credits ??= {};
    for (const [group, value] of Object.entries(values)) {
      credits[group] = (credits[group] ?? 0) + value;
    }
  }
  return credits;
}

/** One day of credits used, keyed by the property Autumn grouped on. */
interface GroupedUsageDay {
  period: number;
  credits: Record<string, number>;
}

/**
 * Rolls daily grouped usage into bins. Groups whose labels match (e.g.
 * several unresolved API key ids all labelled "Unknown") are merged, so the
 * result has one row per label per bin, sorted by label.
 */
function aggregateGroupedPeriods(
  days: GroupedUsageDay[],
  bin: HistoricalBin,
  label: (group: string) => string,
): {
  startDate: string;
  endDate: string | null;
  label: string;
  creditsUsed: number;
}[] {
  const binGroupTotals = new Map<string, Map<string, number>>();

  for (const day of days) {
    const binStart = toBinStartIso(day.period, bin);
    if (!binStart) continue;

    const binTotals = binGroupTotals.get(binStart) ?? new Map<string, number>();

    for (const [group, creditsUsed] of Object.entries(day.credits)) {
      binTotals.set(group, (binTotals.get(group) ?? 0) + creditsUsed);
    }

    binGroupTotals.set(binStart, binTotals);
  }

  const binStarts = [...binGroupTotals.keys()].sort();
  const results: {
    startDate: string;
    endDate: string | null;
    label: string;
    creditsUsed: number;
  }[] = [];

  for (let i = 0; i < binStarts.length; i++) {
    const startDate = binStarts[i];
    const endDate =
      i < binStarts.length - 1 ? nextBinIso(startDate, bin) : null;
    const binTotals = binGroupTotals.get(startDate);

    if (!binTotals) continue;

    const byLabel = new Map<string, number>();
    for (const [group, creditsUsed] of binTotals) {
      const name = label(group);
      byLabel.set(name, (byLabel.get(name) ?? 0) + creditsUsed);
    }

    for (const [name, creditsUsed] of [...byLabel.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      results.push({ startDate, endDate, label: name, creditsUsed });
    }
  }

  return results;
}

async function aggregateHistoricalPeriodsByApiKey(
  days: GroupedUsageDay[],
  bin: HistoricalBin,
): Promise<HistoricalPeriodByApiKey[]> {
  const apiKeyIds = new Set(days.flatMap(day => Object.keys(day.credits)));
  const nameMap = await lookupApiKeyNames([...apiKeyIds]);

  return aggregateGroupedPeriods(days, bin, apiKeyId => nameMap[apiKeyId]).map(
    ({ startDate, endDate, label, creditsUsed }) => ({
      startDate,
      endDate,
      apiKey: label,
      creditsUsed,
    }),
  );
}

function aggregateHistoricalPeriodsByEndpoint(
  days: GroupedUsageDay[],
  bin: HistoricalBin,
): HistoricalPeriodByEndpoint[] {
  return aggregateGroupedPeriods(
    days,
    bin,
    endpoint => endpoint || "unknown",
  ).map(({ startDate, endDate, label, creditsUsed }) => ({
    startDate,
    endDate,
    endpoint: label,
    creditsUsed,
  }));
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

interface HistoricalPeriodByEndpoint {
  startDate: string | null;
  endDate: string | null;
  endpoint: string;
  creditsUsed: number;
}

/**
 * Fetches a team's historical credit usage across billing periods from Autumn.
 *
 * Scopes the aggregate to the team's Autumn entity so the response reflects
 * only that team's usage, not the whole org. Uses `events.aggregate` with the
 * last 90 days of daily usage and rolls those daily totals into calendar-month
 * (or, with `bin` "day", daily) buckets in API code. A team with no entity
 * (never provisioned) has no team-scoped usage, so we return an empty history
 * rather than the org total.
 */
export async function getTeamHistoricalUsage(
  teamId: string,
  bin: HistoricalBin = "month",
): Promise<HistoricalPeriod[]> {
  if (!autumnClient) {
    throw new Error(
      "Autumn client is not configured (AUTUMN_SECRET_KEY missing)",
    );
  }

  const orgId = await lookupOrgId(teamId);

  let response: any;
  try {
    response = await autumnClient.events.aggregate(
      {
        customerId: orgId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        range: HISTORICAL_RANGE,
        binSize: HISTORICAL_BIN_SIZE,
      },
      { timeoutMs: HISTORICAL_AGGREGATE_TIMEOUT_MS },
    );
  } catch (err: any) {
    const status = err?.statusCode ?? err?.status ?? err?.response?.status;
    if (status !== 404) throw err;
    // Entity not found — the team has no usage of its own to report.
    return [];
  }

  return aggregateHistoricalPeriods(response.list ?? [], bin);
}

interface UsageSlice {
  start: number;
  end: number;
}

/**
 * The fixed 7-day slices covering `[windowStart, now]`, oldest first. They
 * are aligned to the Unix epoch rather than to the window, so a slice keeps
 * the same bounds (and cache key) while the window slides over it.
 */
function groupedSlices(windowStart: number, now: number): UsageSlice[] {
  const slices: UsageSlice[] = [];
  let start = Math.floor(windowStart / GROUPED_SLICE_MS) * GROUPED_SLICE_MS;
  for (; start <= now; start += GROUPED_SLICE_MS) {
    slices.push({ start, end: start + GROUPED_SLICE_MS });
  }
  return slices;
}

function sliceCacheKey(
  grouping: UsageGrouping,
  teamId: string,
  slice: UsageSlice,
): string {
  return `${grouping.cachePrefix}:${teamId}:${slice.start}`;
}

function isGroupedUsageDays(value: unknown): value is GroupedUsageDay[] {
  return (
    Array.isArray(value) &&
    value.every(
      day =>
        typeof day?.period === "number" &&
        typeof day.credits === "object" &&
        day.credits !== null &&
        !Array.isArray(day.credits) &&
        Object.values(day.credits).every(v => typeof v === "number"),
    )
  );
}

async function readCachedSlice(
  grouping: UsageGrouping,
  teamId: string,
  slice: UsageSlice,
): Promise<GroupedUsageDay[] | null> {
  try {
    const cached = await getValue(sliceCacheKey(grouping, teamId, slice));
    if (cached === null) return null;
    const parsed = JSON.parse(cached);
    if (isGroupedUsageDays(parsed)) return parsed;
    logger.warn("Ignoring malformed historical usage cache entry", {
      teamId,
      sliceStart: slice.start,
    });
  } catch (error) {
    logger.warn("Failed to read historical usage cache", {
      teamId,
      sliceStart: slice.start,
      error,
    });
  }
  return null;
}

async function writeCachedSlice(
  grouping: UsageGrouping,
  teamId: string,
  slice: UsageSlice,
  days: GroupedUsageDay[],
): Promise<void> {
  try {
    await setValue(
      sliceCacheKey(grouping, teamId, slice),
      JSON.stringify(days),
      GROUPED_SLICE_CACHE_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn("Failed to cache historical usage slice", {
      teamId,
      sliceStart: slice.start,
      error,
    });
  }
}

async function fetchGroupedUsageSlice(
  client: NonNullable<typeof autumnClient>,
  grouping: UsageGrouping,
  orgId: string,
  teamId: string,
  slice: UsageSlice,
  now: number,
): Promise<GroupedUsageDay[]> {
  const response: any = await client.events.aggregate(
    {
      customerId: orgId,
      entityId: teamId,
      featureId: grouping.featureId,
      customRange: { start: slice.start, end: Math.min(slice.end, now) },
      binSize: HISTORICAL_BIN_SIZE,
      groupBy: grouping.groupBy,
      maxGroups: GROUPED_MAX_GROUPS,
    },
    {
      timeoutMs: HISTORICAL_AGGREGATE_TIMEOUT_MS,
      ...GROUPED_RATE_LIMIT_RETRY,
    },
  );

  const days: GroupedUsageDay[] = [];
  for (const entry of response?.list ?? []) {
    const period = new Date(entry.period).getTime();
    // A bin outside the slice belongs to its neighbour, which counts it.
    if (!(period >= slice.start && period < slice.end)) continue;

    const credits = getGroupedCredits(entry, grouping);
    if (credits) days.push({ period, credits });
  }
  return days;
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight, keeping the
 * results in input order. After the first failure no further item is started,
 * and that failure is what rejects.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Fetches a team's daily usage over the 90 days up to now, from the start of
 * that UTC day, grouped by the grouping's event property. The days come from
 * 7-day slices (see `GROUPED_SLICE_MS`): the slice holding today is always
 * asked for live and first, so a team with no entity answers 404 there and
 * gets no days; settled slices come from the cache when they can.
 */
async function getTeamGroupedUsageDays(
  teamId: string,
  grouping: UsageGrouping,
): Promise<GroupedUsageDay[]> {
  const client = autumnClient;
  if (!client) {
    throw new Error(
      "Autumn client is not configured (AUTUMN_SECRET_KEY missing)",
    );
  }

  const orgId = await lookupOrgId(teamId);

  const now = Date.now();
  const windowStart =
    Math.floor((now - HISTORICAL_WINDOW_MS) / DAY_MS) * DAY_MS;
  const slices = groupedSlices(windowStart, now);
  const currentSlice = slices[slices.length - 1];
  const earlierSlices = slices.slice(0, -1);

  let currentDays: GroupedUsageDay[];
  try {
    currentDays = await fetchGroupedUsageSlice(
      client,
      grouping,
      orgId,
      teamId,
      currentSlice,
      now,
    );
  } catch (err: any) {
    const status = err?.statusCode ?? err?.status ?? err?.response?.status;
    if (status !== 404) throw err;
    // Entity not found — the team has no usage of its own to report.
    return [];
  }

  const earlierDays = await mapWithConcurrency(
    earlierSlices,
    GROUPED_SLICE_CONCURRENCY,
    async slice => {
      const settled = slice.end <= now - GROUPED_SLICE_SETTLE_MS;
      if (settled) {
        const cached = await readCachedSlice(grouping, teamId, slice);
        if (cached !== null) return cached;
      }

      const days = await fetchGroupedUsageSlice(
        client,
        grouping,
        orgId,
        teamId,
        slice,
        now,
      );
      if (settled) await writeCachedSlice(grouping, teamId, slice, days);
      return days;
    },
  );

  return [...earlierDays.flat(), ...currentDays].filter(
    day => day.period >= windowStart,
  );
}

/**
 * Fetches a team's historical credit usage grouped by API key from Autumn,
 * rolled into calendar-month (or, with `bin` "day", daily) buckets.
 */
export async function getTeamHistoricalUsageByApiKey(
  teamId: string,
  bin: HistoricalBin = "month",
): Promise<HistoricalPeriodByApiKey[]> {
  return aggregateHistoricalPeriodsByApiKey(
    await getTeamGroupedUsageDays(teamId, API_KEY_GROUPING),
    bin,
  );
}

/**
 * Fetches a team's historical credit usage grouped by the endpoint that
 * billed it (scrape, search, crawl, ...) from Autumn, rolled into
 * calendar-month (or, with `bin` "day", daily) buckets. Unlike the totals
 * and the byApiKey breakdown, it includes search usage.
 */
export async function getTeamHistoricalUsageByEndpoint(
  teamId: string,
  bin: HistoricalBin = "month",
): Promise<HistoricalPeriodByEndpoint[]> {
  return aggregateHistoricalPeriodsByEndpoint(
    await getTeamGroupedUsageDays(teamId, ENDPOINT_GROUPING),
    bin,
  );
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
