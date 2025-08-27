import type { ConcurrencyCheck, CreditUsage, TokenUsage } from "../types";
import { HttpClient } from "../utils/httpClient";
import { normalizeAxiosError, throwForBadResponse } from "../utils/errorHandler";

export async function getConcurrency(http: HttpClient): Promise<ConcurrencyCheck> {
  try {
    const res = await http.get<{ success: boolean; data?: { concurrency: number; maxConcurrency: number } }>("/v2/concurrency-check");
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get concurrency");
    const d = res.data.data || (res.data as any);
    return { concurrency: d.concurrency, maxConcurrency: d.maxConcurrency ?? d.max_concurrency };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get concurrency");
    throw err;
  }
}

export async function getCreditUsage(http: HttpClient): Promise<CreditUsage> {
  try {
    const res = await http.get<{ success: boolean; data?: { remainingCredits?: number; remaining_credits?: number } }>("/v2/team/credit-usage");
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get credit usage");
    const d = res.data.data || (res.data as any);
    return { remainingCredits: d.remainingCredits ?? d.remaining_credits ?? 0 };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get credit usage");
    throw err;
  }
}

export async function getTokenUsage(http: HttpClient): Promise<TokenUsage> {
  try {
    const res = await http.get<{ success: boolean; data?: TokenUsage }>("/v2/team/token-usage");
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get token usage");
    return (res.data.data || (res.data as any)) as TokenUsage;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get token usage");
    throw err;
  }
}

