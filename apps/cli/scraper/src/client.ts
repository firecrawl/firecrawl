import { setTimeout as delay } from "node:timers/promises";
import type { ScrapeResponseData } from "./formats/types.js";

export interface ClientOptions {
  apiUrl: string;
  retries: { attempts: number; initialDelayMs: number };
}

export interface ScrapeRequest {
  url: string;
  formats?: string[] | undefined;
  onlyMainContent?: boolean | undefined;
  waitFor?: number | undefined;
  includeTags?: string[] | undefined;
  excludeTags?: string[] | undefined;
  headers?: Record<string, string> | undefined;
  actions?: unknown[] | undefined;
  timeout?: number | undefined;
}

export interface CrawlRequest {
  url: string;
  limit?: number | undefined;
  maxDepth?: number | undefined;
  includePaths?: string[] | undefined;
  excludePaths?: string[] | undefined;
  scrapeOptions?: Omit<ScrapeRequest, "url"> | undefined;
}

export interface MapRequest {
  url: string;
  search?: string | undefined;
  limit?: number | undefined;
  ignoreSitemap?: boolean | undefined;
  includeSubdomains?: boolean | undefined;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface CrawlStartResponse {
  success: boolean;
  id?: string;
  url?: string;
  error?: string;
}

interface CrawlStatusResponse {
  status: "scraping" | "completed" | "failed" | "cancelled";
  total: number;
  completed: number;
  data?: ScrapeResponseData[];
  next?: string;
  error?: string;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal });
}

export class Client {
  constructor(private readonly opts: ClientOptions) {}

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.opts.apiUrl.replace(/\/$/, "")}${path}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.retries.attempts; attempt++) {
      try {
        const res = await fetch(url, init);
        if (!res.ok) {
          if (RETRYABLE_STATUS.has(res.status) && attempt < this.opts.retries.attempts) {
            const retryAfter = Number(res.headers.get("retry-after"));
            const delay =
              Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : this.opts.retries.initialDelayMs * 2 ** attempt;
            await res.body?.cancel();
            await sleep(delay, init.signal ?? undefined);
            continue;
          }
          const body = await res.text();
          throw new Error(`${path} → ${res.status} ${res.statusText}: ${body}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        init.signal?.throwIfAborted();
        lastErr = err;
        if (attempt < this.opts.retries.attempts) {
          await sleep(this.opts.retries.initialDelayMs * 2 ** attempt, init.signal ?? undefined);
          continue;
        }
        break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async scrape(req: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResponseData> {
    const env = await this.request<ApiEnvelope<ScrapeResponseData>>("/v1/scrape", {
      ...(signal ? { signal } : {}),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!env.success || !env.data) {
      throw new Error(`scrape failed: ${env.error ?? "no data"}`);
    }
    return env.data;
  }

  async map(req: MapRequest): Promise<string[]> {
    const env = await this.request<ApiEnvelope<unknown> & { links?: string[] }>("/v1/map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (env.links && Array.isArray(env.links)) return env.links;
    if (env.data && Array.isArray(env.data)) return env.data as string[];
    throw new Error(`map failed: ${env.error ?? "no links"}`);
  }

  async startCrawl(req: CrawlRequest): Promise<string> {
    const env = await this.request<CrawlStartResponse>("/v1/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!env.success || !env.id) {
      throw new Error(`crawl start failed: ${env.error ?? "no id"}`);
    }
    return env.id;
  }

  async getCrawlStatus(id: string): Promise<CrawlStatusResponse> {
    return this.request<CrawlStatusResponse>(`/v1/crawl/${id}`, { method: "GET" });
  }

  async *streamCrawl(
    id: string,
    pollMs = 2000,
  ): AsyncIterable<{ status: CrawlStatusResponse; pages: ScrapeResponseData[] }> {
    let seen = 0;
    while (true) {
      const status = await this.getCrawlStatus(id);
      const data = status.data ?? [];
      const fresh = data.slice(seen);
      seen = data.length;
      yield { status, pages: fresh };
      if (
        status.status === "completed" ||
        status.status === "failed" ||
        status.status === "cancelled"
      ) {
        return;
      }
      await sleep(pollMs);
    }
  }
}
