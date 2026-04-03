import { logger } from "../../lib/logger";
import { supabase_rr_service } from "../supabase";
import { autumnClient } from "./client";

const CREDITS_FEATURE_ID = "CREDITS";

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

interface HistoricalPeriod {
  startDate: string | null;
  endDate: string | null;
  creditsUsed: number;
  apiKeyName?: string;
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
 * Resolves numeric API key IDs to their human-readable names.
 * Returns a map of id → name. Unknown IDs are omitted.
 */
async function resolveApiKeyNames(
  apiKeyIds: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  if (apiKeyIds.length === 0) return nameMap;

  const numericIds = apiKeyIds
    .map(id => parseInt(id, 10))
    .filter(n => !Number.isNaN(n));

  if (numericIds.length === 0) return nameMap;

  const { data, error } = await supabase_rr_service
    .from("api_keys")
    .select("id, name")
    .in("id", numericIds);

  if (error || !data) return nameMap;

  for (const row of data) {
    nameMap.set(String(row.id), row.name);
  }
  return nameMap;
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
    throw new Error("Autumn client is not configured (AUTUMN_SECRET_KEY missing)");
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

  // Fall back to customer-level balance if CREDITS feature not present
  if (!balances?.[CREDITS_FEATURE_ID]) {
    const customer = await autumnClient.customers.getOrCreate({
      customerId: orgId,
      autoEnablePlanId: "free",
    });
    balances = customer?.balances;
    subscriptions = customer?.subscriptions;
  }

  const creditBalance = balances?.[CREDITS_FEATURE_ID];

  if (!creditBalance) {
    return null;
  }

  // Find the active subscription's billing period
  const activeSub = subscriptions?.find(
    (s: any) =>
      s.status === "active" ||
      s.status === "trialing" ||
      s.status === "past_due",
  );

  const periodStartEpoch = activeSub?.currentPeriodStart;
  const periodEndEpoch = activeSub?.currentPeriodEnd;

  // Extract plan-only credits from the breakdown (excludes credit packs,
  // auto-recharge, etc.) to preserve backwards compatibility with the old
  // planCredits field semantics.
  let planCredits = creditBalance?.granted ?? 0;
  const breakdowns: Array<any> | undefined = creditBalance?.breakdown;
  if (breakdowns?.length) {
    planCredits = breakdowns.reduce(
      (sum: number, b: any) => sum + (b.includedGrant ?? 0),
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
      ? new Date(periodStartEpoch * 1000).toISOString()
      : null,
    periodEnd: periodEndEpoch
      ? new Date(periodEndEpoch * 1000).toISOString()
      : null,
  };
}

// ---------------------------------------------------------------------------
// Historical usage (billing-period-aligned bins)
// ---------------------------------------------------------------------------

/**
 * Number of past billing periods to return (including current).
 */
const HISTORICAL_PERIOD_COUNT = 4;

/**
 * Fetches historical credit usage aligned to billing period boundaries.
 *
 * Uses Autumn's events.aggregate endpoint with custom date ranges that
 * correspond to each billing cycle, providing consistency with the
 * subscription billing model.
 */
export async function getHistoricalUsage(
  teamId: string,
  byApiKey: boolean,
): Promise<HistoricalPeriod[] | null> {
  if (!autumnClient) return null;

  try {
    const orgId = await lookupOrgId(teamId);

    // Resolve billing period boundaries from the subscription
    let subscriptions: Array<any> | undefined;
    try {
      const entity = await autumnClient.entities.get({
        customerId: orgId,
        entityId: teamId,
      });
      subscriptions = entity?.subscriptions;
    } catch (err: any) {
      const status = err?.statusCode ?? err?.status ?? err?.response?.status;
      if (status !== 404) throw err;
    }

    if (!subscriptions?.length) {
      const customer = await autumnClient.customers.getOrCreate({
        customerId: orgId,
      });
      subscriptions = customer?.subscriptions;
    }

    const activeSub = subscriptions?.find(
      (s: any) =>
        s.status === "active" ||
        s.status === "trialing" ||
        s.status === "past_due",
    );

    if (!activeSub?.currentPeriodStart || !activeSub?.currentPeriodEnd) {
      return [];
    }

    // Epoch seconds from Autumn
    const currentStart = activeSub.currentPeriodStart;
    const currentEnd = activeSub.currentPeriodEnd;
    const periodLengthSec = currentEnd - currentStart;

    if (periodLengthSec <= 0) return [];

    // Build period boundaries going backwards from the current period
    const periods: Array<{ start: number; end: number }> = [];
    for (let i = HISTORICAL_PERIOD_COUNT - 1; i >= 0; i--) {
      const start = currentStart - i * periodLengthSec;
      const end = currentEnd - i * periodLengthSec;
      periods.push({ start, end });
    }

    // Fetch aggregate usage for each period in parallel
    const aggregatePromises = periods.map(p =>
      autumnClient!.events
        .aggregate({
          customerId: orgId,
          entityId: teamId,
          featureId: CREDITS_FEATURE_ID,
          customRange: {
            start: p.start * 1000, // Autumn expects epoch ms
            end: p.end * 1000,
          },
          ...(byApiKey ? { groupBy: "properties.apiKeyId" } : {}),
        })
        .catch(err => {
          logger.warn("Autumn events.aggregate failed for period", {
            teamId,
            period: p,
            error: err,
          });
          return null;
        }),
    );

    const results = await Promise.all(aggregatePromises);

    // Collect all unique API key IDs across results so we can resolve names
    const allApiKeyIds = new Set<string>();
    const historicalPeriods: HistoricalPeriod[] = [];

    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      const result = results[i];
      const startDate = new Date(p.start * 1000).toISOString();
      const endDate = new Date(p.end * 1000).toISOString();

      if (!result) {
        // Aggregate call failed for this period — include zero-value entry
        historicalPeriods.push({ startDate, endDate, creditsUsed: 0 });
        continue;
      }

      if (byApiKey && result.list?.length) {
        // Flatten grouped values across all bins in this period
        const apiKeyTotals = new Map<string, number>();
        for (const bin of result.list) {
          if (bin.groupedValues) {
            for (const [apiKeyId, values] of Object.entries(
              bin.groupedValues,
            )) {
              const current = apiKeyTotals.get(apiKeyId) ?? 0;
              apiKeyTotals.set(
                apiKeyId,
                current + (values[CREDITS_FEATURE_ID] ?? 0),
              );
            }
          }
        }

        if (apiKeyTotals.size === 0) {
          // No grouped data — fall back to total
          const total = result.total?.[CREDITS_FEATURE_ID]?.sum ?? 0;
          historicalPeriods.push({ startDate, endDate, creditsUsed: total });
        } else {
          for (const [apiKeyId, amount] of apiKeyTotals) {
            allApiKeyIds.add(apiKeyId);
            historicalPeriods.push({
              startDate,
              endDate,
              creditsUsed: amount,
              // Temporarily store ID; will be replaced with name below
              apiKeyName: apiKeyId,
            });
          }
        }
      } else {
        // Total across the period
        const total = result.total?.[CREDITS_FEATURE_ID]?.sum ?? 0;
        historicalPeriods.push({ startDate, endDate, creditsUsed: total });
      }
    }

    // Resolve API key IDs to human-readable names
    if (allApiKeyIds.size > 0) {
      const nameMap = await resolveApiKeyNames([...allApiKeyIds]);
      for (const period of historicalPeriods) {
        if (period.apiKeyName && nameMap.has(period.apiKeyName)) {
          period.apiKeyName = nameMap.get(period.apiKeyName)!;
        }
      }
    }

    // Sort ascending by start date
    historicalPeriods.sort((a, b) => {
      const aTime = a.startDate ? Date.parse(a.startDate) : NaN;
      const bTime = b.startDate ? Date.parse(b.startDate) : NaN;
      if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
      if (Number.isNaN(aTime)) return 1;
      if (Number.isNaN(bTime)) return -1;
      return aTime - bTime;
    });

    return historicalPeriods;
  } catch (error) {
    logger.error("Failed to get historical usage from Autumn", {
      teamId,
      error,
    });
    return null;
  }
}
