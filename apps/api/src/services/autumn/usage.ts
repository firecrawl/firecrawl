import { logger } from "../../lib/logger";
import { supabase_rr_service } from "../supabase";
import { autumnClient } from "./client";

const CREDITS_FEATURE_ID = "CREDITS";
const TOKENS_PER_CREDIT = 15;
const HISTORICAL_RANGE = "90d";
const HISTORICAL_BIN_SIZE = "day";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamBalance {
  remaining: number;
  granted: number;
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
  const { data, error } = await supabase_rr_service
    .from("teams")
    .select("org_id")
    .eq("id", teamId)
    .single();

  if (error) throw error;
  if (!data?.org_id) {
    throw new Error(`Missing org_id for team ${teamId}`);
  }
  return data.org_id;
}

/**
 * Maps numeric API key IDs to their display names from the api_keys table.
 * Returns a map of id → name.  Unknown IDs are mapped to their string representation.
 */
async function lookupApiKeyNames(
  apiKeyIds: string[],
): Promise<Record<string, string>> {
  const numericIds = apiKeyIds
    .map(id => Number(id))
    .filter(n => !isNaN(n) && n > 0);

  const nameMap: Record<string, string> = {};

  if (numericIds.length > 0) {
    const { data } = await supabase_rr_service
      .from("api_keys")
      .select("id, name")
      .in("id", numericIds);

    if (data) {
      for (const row of data) {
        nameMap[String(row.id)] = row.name;
      }
    }
  }

  // Fall back to raw ID string for any keys not found
  for (const id of apiKeyIds) {
    if (!nameMap[id]) {
      nameMap[id] = id;
    }
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

function aggregateHistoricalPeriodsByMonth(list: any[]): HistoricalPeriod[] {
  const monthTotals = new Map<string, number>();

  for (const entry of list) {
    const monthStart = toMonthStartIso(entry.period);
    if (!monthStart) continue;

    monthTotals.set(
      monthStart,
      (monthTotals.get(monthStart) ?? 0) +
        (entry.values?.[CREDITS_FEATURE_ID] ?? 0),
    );
  }

  const monthStarts = [...monthTotals.keys()].sort();

  return monthStarts.map((startDate, i) => ({
    startDate,
    endDate: i < monthStarts.length - 1 ? nextMonthIso(startDate) : null,
    creditsUsed: monthTotals.get(startDate) ?? 0,
  }));
}

function getGroupedCredits(entry: any): Record<string, number> | undefined {
  return (
    entry.groupedValues?.[CREDITS_FEATURE_ID] ??
    entry.grouped_values?.[CREDITS_FEATURE_ID]
  );
}

async function aggregateHistoricalPeriodsByApiKeyMonth(
  list: any[],
): Promise<HistoricalPeriodByApiKey[]> {
  const monthApiKeyTotals = new Map<string, Map<string, number>>();
  const allApiKeyIds = new Set<string>();

  for (const entry of list) {
    const monthStart = toMonthStartIso(entry.period);
    if (!monthStart) continue;

    const grouped = getGroupedCredits(entry);
    if (!grouped) continue;

    const monthTotals =
      monthApiKeyTotals.get(monthStart) ?? new Map<string, number>();

    for (const [apiKeyId, creditsUsed] of Object.entries(grouped)) {
      allApiKeyIds.add(apiKeyId);
      monthTotals.set(apiKeyId, (monthTotals.get(apiKeyId) ?? 0) + creditsUsed);
    }

    monthApiKeyTotals.set(monthStart, monthTotals);
  }

  const nameMap = await lookupApiKeyNames([...allApiKeyIds]);
  const monthStarts = [...monthApiKeyTotals.keys()].sort();
  const results: HistoricalPeriodByApiKey[] = [];

  for (let i = 0; i < monthStarts.length; i++) {
    const startDate = monthStarts[i];
    const endDate = i < monthStarts.length - 1 ? nextMonthIso(startDate) : null;
    const monthTotals = monthApiKeyTotals.get(startDate);

    if (!monthTotals) continue;

    for (const [apiKeyId, creditsUsed] of [...monthTotals.entries()].sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      results.push({
        startDate,
        endDate,
        apiKey: nameMap[apiKeyId],
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
    remaining: creditBalance?.remaining ?? 0,
    granted: creditBalance?.granted ?? 0,
    planCredits,
    usage: creditBalance?.usage ?? 0,
    unlimited: creditBalance?.unlimited ?? false,
    periodStart: periodStartEpoch
      ? new Date(periodStartEpoch).toISOString()
      : null,
    periodEnd: periodEndEpoch ? new Date(periodEndEpoch).toISOString() : null,
  };
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

/**
 * Fetches a team's historical credit usage across billing periods from Autumn.
 *
 * Uses `events.aggregate` with the last 90 days of daily usage and rolls those
 * daily totals into calendar-month buckets in API code.
 */
export async function getTeamHistoricalUsage(
  teamId: string,
): Promise<HistoricalPeriod[]> {
  if (!autumnClient) {
    throw new Error(
      "Autumn client is not configured (AUTUMN_SECRET_KEY missing)",
    );
  }

  const orgId = await lookupOrgId(teamId);

  // Try entity-scoped aggregate first, fall back to customer-level
  let response: any;
  try {
    response = await autumnClient.events.aggregate({
      customerId: orgId,
      entityId: teamId,
      featureId: CREDITS_FEATURE_ID,
      range: HISTORICAL_RANGE,
      binSize: HISTORICAL_BIN_SIZE,
    });
  } catch (err: any) {
    const status = err?.statusCode ?? err?.status ?? err?.response?.status;
    if (status !== 404) throw err;
    // Entity not found — retry at customer level
    response = await autumnClient.events.aggregate({
      customerId: orgId,
      featureId: CREDITS_FEATURE_ID,
      range: HISTORICAL_RANGE,
      binSize: HISTORICAL_BIN_SIZE,
    });
  }

  return aggregateHistoricalPeriodsByMonth(response.list ?? []);
}

/**
 * Fetches a team's historical credit usage grouped by API key from Autumn.
 *
 * Uses the last 90 days of daily usage plus `groupBy: "properties.apiKeyId"`
 * and rolls those daily totals into calendar-month buckets in API code.
 */
export async function getTeamHistoricalUsageByApiKey(
  teamId: string,
): Promise<HistoricalPeriodByApiKey[]> {
  if (!autumnClient) {
    throw new Error(
      "Autumn client is not configured (AUTUMN_SECRET_KEY missing)",
    );
  }

  const orgId = await lookupOrgId(teamId);

  let response: any;
  try {
    response = await autumnClient.events.aggregate({
      customerId: orgId,
      entityId: teamId,
      featureId: CREDITS_FEATURE_ID,
      range: HISTORICAL_RANGE,
      binSize: HISTORICAL_BIN_SIZE,
      groupBy: "properties.apiKeyId",
    });
  } catch (err: any) {
    const status = err?.statusCode ?? err?.status ?? err?.response?.status;
    if (status !== 404) throw err;
    response = await autumnClient.events.aggregate({
      customerId: orgId,
      featureId: CREDITS_FEATURE_ID,
      range: HISTORICAL_RANGE,
      binSize: HISTORICAL_BIN_SIZE,
      groupBy: "properties.apiKeyId",
    });
  }

  return aggregateHistoricalPeriodsByApiKeyMonth(response.list ?? []);
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
