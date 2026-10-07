import {
  type ActiveCrawlsResponse,
  type CrawlErrorsResponse,
  type CrawlJob,
  type CrawlResponse,
  type Document,
  type CrawlOptions,
  type PaginationConfig,
  JobTimeoutError,
  SdkError,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import { ensureValidScrapeOptions } from "../utils/validation";
import { normalizeAxiosError, throwForBadResponse, isRetryableError } from "../utils/errorHandler";
import type { HttpClient as _Http } from "../utils/httpClient";
import { fetchAllPages } from "../utils/pagination";

export type CrawlRequest = CrawlOptions & {
  url: string;
};

function prepareCrawlPayload(request: CrawlRequest): Record<string, unknown> {
  if (!request.url || !request.url.trim()) throw new Error("URL cannot be empty");
  const data: Record<string, unknown> = { url: request.url.trim() };
  if (request.prompt) data.prompt = request.prompt;
  if (request.excludePaths) data.excludePaths = request.excludePaths;
  if (request.includePaths) data.includePaths = request.includePaths;
  if (request.maxDiscoveryDepth != null) data.maxDiscoveryDepth = request.maxDiscoveryDepth;
  if (request.sitemap != null) data.sitemap = request.sitemap;
  if (request.robotsUserAgent != null) data.robotsUserAgent = request.robotsUserAgent;
  if (request.ignoreQueryParameters != null) data.ignoreQueryParameters = request.ignoreQueryParameters;
  if (request.deduplicateSimilarURLs != null) data.deduplicateSimilarURLs = request.deduplicateSimilarURLs;
  if (request.limit != null) data.limit = request.limit;
  if (request.crawlEntireDomain != null) data.crawlEntireDomain = request.crawlEntireDomain;
  if (request.allowExternalLinks != null) data.allowExternalLinks = request.allowExternalLinks;
  if (request.allowSubdomains != null) data.allowSubdomains = request.allowSubdomains;
  if (request.delay != null) data.delay = request.delay;
  if (request.maxConcurrency != null) data.maxConcurrency = request.maxConcurrency;
  if (request.regexOnFullURL != null) data.regexOnFullURL = request.regexOnFullURL;
  if (request.webhook != null) data.webhook = request.webhook;
  if (request.integration != null && request.integration.trim()) data.integration = request.integration.trim();
  if (request.origin) data.origin = request.origin;
  if (request.scrapeOptions) {
    ensureValidScrapeOptions(request.scrapeOptions);
    data.scrapeOptions = request.scrapeOptions;
  }
  if (request.zeroDataRetention != null) data.zeroDataRetention = request.zeroDataRetention;
  return data;
}

export async function startCrawl(http: HttpClient, request: CrawlRequest): Promise<CrawlResponse> {
  const payload = prepareCrawlPayload(request);
  try {
    const res = await http.post<{ success: boolean; id: string; url: string; error?: string }>("/v2/crawl", payload);
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "start crawl");
    }
    return { id: res.data.id, url: res.data.url };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "start crawl");
    throw err;
  }
}

export async function getCrawlStatus(
  http: HttpClient,
  jobId: string,
  pagination?: PaginationConfig
): Promise<CrawlJob> {
  try {
    const res = await http.get<{ success: boolean; status: CrawlJob["status"]; completed?: number; total?: number; creditsUsed?: number; expiresAt?: string; next?: string | null; data?: Document[] }>(`/v2/crawl/${jobId}`);
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "get crawl status");
    }
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
    if (err?.isAxiosError) return normalizeAxiosError(err, "get crawl status");
    throw err;
  }
}

/**
 * Cancel a crawl job. Resolves `false` when the API answers 409 because the
 * crawl already finished, so there is nothing left to cancel.
 */
export async function cancelCrawl(http: HttpClient, jobId: string): Promise<boolean> {
  try {
    const res = await http.delete<{ status: string }>(`/v2/crawl/${jobId}`);
    if (res.status === 409) return false;
    if (res.status !== 200) throwForBadResponse(res, "cancel crawl");
    return res.data?.status === "cancelled";
  } catch (err: any) {
    if (err?.isAxiosError) {
      if (err.response?.status === 409) return false;
      return normalizeAxiosError(err, "cancel crawl");
    }
    throw err;
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException("This operation was aborted", "AbortError");
}

/** Reject with the abort reason as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll a crawl until it reaches a terminal status. When `signal` aborts, polling
 * stops and the promise rejects with the abort reason. The job is not cancelled.
 */
export async function waitForCrawlCompletion(
  http: HttpClient,
  jobId: string,
  pollInterval = 2,
  timeout?: number,
  signal?: AbortSignal,
): Promise<CrawlJob> {
  const start = Date.now();
  
  while (true) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      const status = await raceAbort(getCrawlStatus(http, jobId), signal);
      
      if (["completed", "failed", "cancelled"].includes(status.status)) {
        return status;
      }
    } catch (err: any) {
      if (signal?.aborted) throw abortReason(signal);
      // Don't retry on permanent errors (4xx) - re-throw immediately with jobId context
      if (!isRetryableError(err)) {
        // Create new error with jobId for better debugging (non-retryable errors like 404)
        if (err instanceof SdkError) {
          const errorWithJobId = new SdkError(
            err.message,
            err.status,
            err.code,
            err.details,
            jobId
          );
          throw errorWithJobId;
        }
        throw err;
      }
      // Otherwise, retry after delay - error might be transient (network issue, timeout, 5xx, etc.)
    }

    if (timeout != null && Date.now() - start > timeout * 1000) {
      throw new JobTimeoutError(jobId, timeout, 'crawl');
    }
    
    await sleep(Math.max(1000, pollInterval * 1000), signal);
  }
}

/**
 * Start a crawl and wait for it to finish. When `signal` aborts, polling stops,
 * the job gets a best-effort cancel request, and the promise rejects with the
 * abort reason at once, without waiting for the cancel. A signal that is already
 * aborted rejects before any request.
 */
export async function crawl(
  http: HttpClient,
  request: CrawlRequest,
  pollInterval = 2,
  timeout?: number,
  signal?: AbortSignal,
): Promise<CrawlJob> {
  if (signal?.aborted) throw abortReason(signal);
  const started = await startCrawl(http, request);
  try {
    return await waitForCrawlCompletion(http, started.id, pollInterval, timeout, signal);
  } catch (err) {
    if (signal?.aborted) cancelCrawl(http, started.id).catch(() => {});
    throw err;
  }
}

export async function getCrawlErrors(http: HttpClient, crawlId: string): Promise<CrawlErrorsResponse> {
  try {
    const res = await http.get<{ success?: boolean; data?: CrawlErrorsResponse }>(`/v2/crawl/${crawlId}/errors`);
    if (res.status !== 200) throwForBadResponse(res, "get crawl errors");
    const payload = res.data?.data ?? (res.data as any);
    return { errors: payload.errors || [], robotsBlocked: payload.robotsBlocked || [] };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get crawl errors");
    throw err;
  }
}

export async function getActiveCrawls(http: HttpClient): Promise<ActiveCrawlsResponse> {
  try {
    const res = await http.get<{ success: boolean; crawls: Array<{ id: string; teamId?: string; team_id?: string; url: string; options?: any }> }>(`/v2/crawl/active`);
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "get active crawls");
    const crawlsIn = res.data?.crawls || [];
    const crawls = crawlsIn.map((c) => ({ id: c.id, teamId: (c as any).teamId ?? (c as any).team_id, url: c.url, options: c.options ?? null }));
    return { success: true, crawls };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get active crawls");
    throw err;
  }
}

export async function crawlParamsPreview(http: HttpClient, url: string, prompt: string): Promise<Record<string, unknown>> {
  if (!url || !url.trim()) throw new Error("URL cannot be empty");
  if (!prompt || !prompt.trim()) throw new Error("Prompt cannot be empty");
  try {
    const res = await http.post<{ success: boolean; data?: Record<string, unknown>; warning?: string }>("/v2/crawl/params-preview", { url: url.trim(), prompt });
    if (res.status !== 200 || !res.data?.success) throwForBadResponse(res, "crawl params preview");
    const data = res.data.data || {};
    if (res.data.warning) (data as any).warning = res.data.warning;
    return data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "crawl params preview");
    throw err;
  }
}
