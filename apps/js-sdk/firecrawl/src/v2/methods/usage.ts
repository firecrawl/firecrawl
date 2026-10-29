import type { ConcurrencyCheck, CreditUsage, QueueStatusResponse, TokenUsage, CreditUsageHistoricalResponse, TokenUsageHistoricalResponse } from "../types";
import { HttpClient } from "../utils/httpClient";
import { normalizeHttpError, throwForBadResponse } from "../utils/errorHandler";

export async function getConcurrency(http: HttpClient): Promise<ConcurrencyCheck> {
  try {
    const res = await http.get<{ success: boolean; data?: { concurrency: number; maxConcurrency: number } }>("/v2/concurrency-check");
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get concurrency");
    const d = res.data.data || (res.data as any);
    return { concurrency: d.concurrency, maxConcurrency: d.maxConcurrency ?? d.max_concurrency };
  } catch (err: any) {
    if (err?.isHttpError) return normalizeHttpError(err, "get concurrency");
    throw err;
  }
}

export async function getCreditUsage(http: HttpClient): Promise<CreditUsage> {
  try {
    const res = await http.get<{ success: boolean; data?: { remainingCredits?: number; remaining_credits?: number; planCredits?: number; plan_credits?: number; billingPeriodStart?: string | null; billing_period_start?: string | null; billingPeriodEnd?: string | null; billing_period_end?: string | null } }>("/v2/team/credit-usage");
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get credit usage");
    const d = res.data.data || (res.data as any);
    return {
      remainingCredits: d.remainingCredits ?? d.remaining_credits ?? 0,
      planCredits: d.planCredits ?? d.plan_credits,
      billingPeriodStart: d.billingPeriodStart ?? d.billing_period_start ?? null,
      billingPeriodEnd: d.billingPeriodEnd ?? d.billing_period_end ?? null,
    };
  } catch (err: any) {
    if (err?.isHttpError) return normalizeHttpError(err, "get credit usage");
    throw err;
  }
}

export async function getTokenUsage(http: HttpClient): Promise<TokenUsage> {
  try {
    const res = await http.get<{ success: boolean; data?: { remainingTokens?: number; planTokens?: number; billingPeriodStart?: string | null; billingPeriodEnd?: string | null; remaining_tokens?: number; plan_tokens?: number; billing_period_start?: string | null; billing_period_end?: string | null } }>("/v2/team/token-usage");
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get token usage");
    const d = res.data.data || (res.data as any);
    return {
      remainingTokens: d.remainingTokens ?? d.remaining_tokens ?? 0,
      planTokens: d.planTokens ?? d.plan_tokens,
      billingPeriodStart: d.billingPeriodStart ?? d.billing_period_start ?? null,
      billingPeriodEnd: d.billingPeriodEnd ?? d.billing_period_end ?? null,
    };
  } catch (err: any) {
    if (err?.isHttpError) return normalizeHttpError(err, "get token usage");
    throw err;
  }
}

export async function getQueueStatus(http: HttpClient): Promise<QueueStatusResponse> {
  try {
    const res = await http.get<QueueStatusResponse>("/v2/team/queue-status");
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get queue status");
    return res.data;
  } catch (err: any) {
    if (err?.isHttpError) return normalizeHttpError(err, "get queue status");
    throw err;
  }
}

export async function getCreditUsageHistorical(http: HttpClient, byApiKey?: boolean): Promise<CreditUsageHistoricalResponse> {
  try {
    const query = byApiKey ? "?byApiKey=true" : "";
    const res = await http.get<CreditUsageHistoricalResponse>(`/v2/team/credit-usage/historical${query}`);
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get credit usage historical");
    return res.data;
  } catch (err: any) {
    if (err?.isHttpError) return normalizeHttpError(err, "get credit usage historical");
    throw err;
  }
}

export async function getTokenUsageHistorical(http: HttpClient, byApiKey?: boolean): Promise<TokenUsageHistoricalResponse> {
  try {
    const query = byApiKey ? "?byApiKey=true" : "";
    const res = await http.get<TokenUsageHistoricalResponse>(`/v2/team/token-usage/historical${query}`);
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get token usage historical");
    return res.data;
  } catch (err: any) {
    if (err?.isHttpError) return normalizeHttpError(err, "get token usage historical");
    throw err;
  }
}
