import { logger } from "../../lib/logger";
import { supabase_rr_service } from "../supabase";
import { autumnClient } from "./client";

const CREDITS_FEATURE_ID = "CREDITS";
const TOKENS_PER_CREDIT = 15;

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
// Historical usage (across billing periods)
// ---------------------------------------------------------------------------

interface HistoricalPeriod {
  startDate: string | null;
  endDate: string | null;
  creditsUsed: number;
}

/**
 * Fetches a team's historical credit usage across billing periods from Autumn.
 *
 * Uses `events.aggregate` with `range: "3bc"` (3 billing cycles) and
 * `binSize: "month"` to return per-period usage totals.
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
      range: "3bc",
      binSize: "month",
    });
  } catch (err: any) {
    const status = err?.statusCode ?? err?.status ?? err?.response?.status;
    if (status !== 404) throw err;
    // Entity not found — retry at customer level
    response = await autumnClient.events.aggregate({
      customerId: orgId,
      featureId: CREDITS_FEATURE_ID,
      range: "3bc",
      binSize: "month",
    });
  }

  return response.list.map((entry: any) => ({
    startDate: new Date(entry.period).toISOString(),
    endDate: null,
    creditsUsed: entry.values?.[CREDITS_FEATURE_ID] ?? 0,
  }));
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
