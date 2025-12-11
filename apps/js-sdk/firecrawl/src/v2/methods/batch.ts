import {
  type BatchScrapeJob,
  type BatchScrapeResponse,
  type CrawlErrorsResponse,
  type Document,
  type BatchScrapeOptions,
  type PaginationConfig,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import { ensureValidScrapeOptions } from "../utils/validation";
import { fetchAllPages } from "../utils/pagination";
import { normalizeAxiosError, throwForBadResponse } from "../utils/errorHandler";

export async function startBatchScrape(
  http: HttpClient,
  urls: string[],
  {
    options,
    webhook,
    appendToId,
    ignoreInvalidURLs,
    maxConcurrency,
    zeroDataRetention,
    idempotencyKey,
    integration,
  }: BatchScrapeOptions = {}
): Promise<BatchScrapeResponse> {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error("URLs list cannot be empty");
  const payload: Record<string, unknown> = { urls };
  if (options) {
    ensureValidScrapeOptions(options);
    Object.assign(payload, options);
  }
  if (webhook != null) payload.webhook = webhook;
  if (appendToId != null) payload.appendToId = appendToId;
  if (ignoreInvalidURLs != null) payload.ignoreInvalidURLs = ignoreInvalidURLs;
  if (maxConcurrency != null) payload.maxConcurrency = maxConcurrency;
  if (zeroDataRetention != null) payload.zeroDataRetention = zeroDataRetention;
  if (integration != null && integration.trim()) payload.integration = integration.trim();

  try {
    const headers = http.prepareHeaders(idempotencyKey);
    const res = await http.post<{ success: boolean; id: string; url: string; invalidURLs?: string[]; error?: string }>("/v2/batch/scrape", payload, headers);
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "start batch scrape");
    return { id: res.data.id, url: res.data.url, invalidURLs: res.data.invalidURLs || undefined };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "start batch scrape");
    throw err;
  }
}

export async function getBatchScrapeStatus(
  http: HttpClient,
  jobId: string,
  pagination?: PaginationConfig
): Promise<BatchScrapeJob> {
  try {
    const res = await http.get<{ success: boolean; status: BatchScrapeJob["status"]; completed?: number; total?: number; creditsUsed?: number; expiresAt?: string; next?: string | null; data?: Document[] }>(`/v2/batch/scrape/${jobId}`);
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get batch scrape status");
    const body = res.data;
    const initialDocs = (body.data || []) as Document[];
    const auto = pagination?.autoPaginate ?? true;
    if (!auto || !body.next) {
      return {
        id: jobId,
        status: body.status,
        completed: body.completed ?? 0,
        total: body.total ?? 0,
        creditsUsed: body.creditsUsed,
        expiresAt: body.expiresAt,
        next: body.next ?? null,
        data: initialDocs,
      };
    }

    const aggregated = await fetchAllPages(http, body.next, initialDocs, pagination);
    return {
      id: jobId,
      status: body.status,
      completed: body.completed ?? 0,
      total: body.total ?? 0,
      creditsUsed: body.creditsUsed,
      expiresAt: body.expiresAt,
      next: null,
      data: aggregated,
    };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get batch scrape status");
    throw err;
  }
}

export async function cancelBatchScrape(http: HttpClient, jobId: string): Promise<boolean> {
  try {
    const res = await http.delete<{ status: string }>(`/v2/batch/scrape/${jobId}`);
    if (res.status !== 200) throwForBadResponse(res, "cancel batch scrape");
    return res.data?.status === "cancelled";
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "cancel batch scrape");
    throw err;
  }
}

export async function getBatchScrapeErrors(http: HttpClient, jobId: string): Promise<CrawlErrorsResponse> {
  try {
    const res = await http.get<{ success?: boolean; data?: { errors: Array<Record<string, string>>; robotsBlocked: string[] } }>(`/v2/batch/scrape/${jobId}/errors`);
    if (res.status !== 200) throwForBadResponse(res, "get batch scrape errors");
    const payload = res.data?.data ?? (res.data as any);
    return { errors: payload.errors || [], robotsBlocked: payload.robotsBlocked || [] };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get batch scrape errors");
    throw err;
  }
}

export async function waitForBatchCompletion(http: HttpClient, jobId: string, pollInterval = 2, timeout?: number): Promise<BatchScrapeJob> {
  const start = Date.now();
  while (true) {
    const status = await getBatchScrapeStatus(http, jobId);
    if (["completed", "failed", "cancelled"].includes(status.status)) return status;
    if (timeout != null && Date.now() - start > timeout * 1000) {
      throw new Error(`Batch scrape job ${jobId} did not complete within ${timeout} seconds`);
    }
    await new Promise((r) => setTimeout(r, Math.max(1000, pollInterval * 1000)));
  }
}

export async function batchScrape(
  http: HttpClient,
  urls: string[],
  opts: BatchScrapeOptions & { pollInterval?: number; timeout?: number } = {}
): Promise<BatchScrapeJob> {
  const start = await startBatchScrape(http, urls, opts);
  return waitForBatchCompletion(http, start.id, opts.pollInterval ?? 2, opts.timeout);
}

export function chunkUrls(urls: string[], chunkSize = 100): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += chunkSize) chunks.push(urls.slice(i, i + chunkSize));
  return chunks;
}
