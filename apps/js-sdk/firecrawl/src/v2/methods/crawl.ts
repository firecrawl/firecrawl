import {
  type ActiveCrawlsResponse,
  type CrawlErrorsResponse,
  type CrawlJob,
  type CrawlResponse,
  type Document,
  type CrawlOptions,
  type PaginationConfig,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import { ensureValidScrapeOptions } from "../utils/validation";
import { normalizeAxiosError, throwForBadResponse } from "../utils/errorHandler";
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
  if (request.ignoreQueryParameters != null) data.ignoreQueryParameters = request.ignoreQueryParameters;
  if (request.limit != null) data.limit = request.limit;
  if (request.crawlEntireDomain != null) data.crawlEntireDomain = request.crawlEntireDomain;
  if (request.allowExternalLinks != null) data.allowExternalLinks = request.allowExternalLinks;
  if (request.allowSubdomains != null) data.allowSubdomains = request.allowSubdomains;
  if (request.delay != null) data.delay = request.delay;
  if (request.maxConcurrency != null) data.maxConcurrency = request.maxConcurrency;
  if (request.webhook != null) data.webhook = request.webhook;
  if (request.integration != null && request.integration.trim()) data.integration = request.integration.trim();
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

export async function cancelCrawl(http: HttpClient, jobId: string): Promise<boolean> {
  try {
    const res = await http.delete<{ status: string }>(`/v2/crawl/${jobId}`);
    if (res.status !== 200) throwForBadResponse(res, "cancel crawl");
    return res.data?.status === "cancelled";
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "cancel crawl");
    throw err;
  }
}

export async function waitForCrawlCompletion(http: HttpClient, jobId: string, pollInterval = 2, timeout?: number): Promise<CrawlJob> {
  const start = Date.now();
  while (true) {
    const status = await getCrawlStatus(http, jobId);
    if (["completed", "failed", "cancelled"].includes(status.status)) return status;
    if (timeout != null && Date.now() - start > timeout * 1000) {
      throw new Error(`Crawl job ${jobId} did not complete within ${timeout} seconds`);
    }
    await new Promise((r) => setTimeout(r, Math.max(1000, pollInterval * 1000)));
  }
}

export async function crawl(http: HttpClient, request: CrawlRequest, pollInterval = 2, timeout?: number): Promise<CrawlJob> {
  const started = await startCrawl(http, request);
  return waitForCrawlCompletion(http, started.id, pollInterval, timeout);
}

export async function getCrawlErrors(http: HttpClient, crawlId: string): Promise<CrawlErrorsResponse> {
  try {
    const res = await http.get<{ success?: boolean; data?: { errors: Array<Record<string, string>>; robotsBlocked: string[] } }>(`/v2/crawl/${crawlId}/errors`);
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
