import { createHash } from "crypto";
import { chInsert } from "./clickhouse-client";
import type { SearchV2Response } from "./entities";
import type { MonitorTarget } from "../services/monitoring/types";

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
}

function normalizeTrackingUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function hashSignature(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// =========================================
// Scrape tracking
// =========================================

interface TrackScrapeParams {
  scrapeId: string;
  requestId: string;
  teamId: string;
  url: string;
  origin: string;
  kind: string;
  isSuccessful: boolean;
  creditsCost: number;
  timeTaken: number;
  zeroDataRetention: boolean;
}

export async function trackScrape(opts: TrackScrapeParams): Promise<void> {
  if (opts.zeroDataRetention) return;

  await chInsert("scrape_results", [
    {
      scrape_id: opts.scrapeId,
      request_id: opts.requestId,
      team_id: opts.teamId,
      url: opts.url,
      url_domain: extractDomain(opts.url),
      origin: opts.origin,
      kind: opts.kind,
      is_successful: opts.isSuccessful,
      credits_cost: opts.creditsCost,
      time_taken: opts.timeTaken,
      created_at: new Date().toISOString(),
    },
  ]);
}

// =========================================
// Monitor target interest tracking
// =========================================

type MonitorTargetInterestEventType =
  | "configured"
  | "deactivated"
  | "check_started";

interface TrackMonitorTargetInterestParams {
  eventType: MonitorTargetInterestEventType;
  teamId: string;
  monitorId: string;
  monitorStatus: string;
  scheduleCron: string;
  scheduleTimezone: string;
  intervalMs: number;
  targets: MonitorTarget[];
  checkId?: string | null;
  zeroDataRetention: boolean;
  eventTime?: Date;
}

function frequencyBucket(intervalSeconds: number): string {
  if (intervalSeconds <= 15 * 60) return "15m";
  if (intervalSeconds <= 30 * 60) return "30m";
  if (intervalSeconds <= 60 * 60) return "hourly";
  if (intervalSeconds <= 6 * 60 * 60) return "sub_daily";
  if (intervalSeconds <= 24 * 60 * 60) return "daily";
  if (intervalSeconds <= 7 * 24 * 60 * 60) return "weekly";
  return "other";
}

function unsignedIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function estimateMonitorTargetCredits(target: MonitorTarget): number {
  if (target.type === "scrape") {
    return target.urls.length;
  }
  if (target.type === "search") {
    return target.maxResults;
  }

  return positiveIntegerOrNull(target.crawlOptions?.limit) ?? 10000;
}

function monitorTargetSignature(target: MonitorTarget): string {
  if (target.type === "scrape") {
    return hashSignature({
      type: "scrape",
      urls: target.urls.map(normalizeTrackingUrl).sort(),
    });
  }
  if (target.type === "search") {
    return hashSignature({
      type: "search",
      queries: [...target.queries].sort(),
      searchWindow: target.searchWindow,
      alertMode: target.alertMode,
      maxResults: target.maxResults,
      depth: target.depth ?? null,
      includeDomains: [...(target.includeDomains ?? [])].sort(),
      excludeDomains: [...(target.excludeDomains ?? [])].sort(),
    });
  }

  return hashSignature({
    type: "crawl",
    url: normalizeTrackingUrl(target.url),
    limit: positiveIntegerOrNull(target.crawlOptions?.limit),
    maxDiscoveryDepth: unsignedIntegerOrNull(
      target.crawlOptions?.maxDiscoveryDepth,
    ),
    includePaths: Array.isArray(target.crawlOptions?.includePaths)
      ? [...target.crawlOptions.includePaths].sort()
      : [],
    excludePaths: Array.isArray(target.crawlOptions?.excludePaths)
      ? [...target.crawlOptions.excludePaths].sort()
      : [],
    crawlEntireDomain: target.crawlOptions?.crawlEntireDomain ?? null,
    allowExternalLinks: target.crawlOptions?.allowExternalLinks ?? null,
    allowSubdomains: target.crawlOptions?.allowSubdomains ?? null,
    sitemap: target.crawlOptions?.sitemap ?? null,
  });
}

export function buildMonitorTargetInterestRows(
  opts: TrackMonitorTargetInterestParams,
): Record<string, unknown>[] {
  const intervalSeconds = Math.max(1, Math.round(opts.intervalMs / 1000));
  const eventTime = (opts.eventTime ?? new Date()).toISOString();
  const isActive =
    opts.eventType !== "deactivated" && opts.monitorStatus === "active";

  return opts.targets.map(target => {
    const isSingleScrapeTarget =
      target.type === "scrape" && target.urls.length === 1;
    const targetUrl =
      target.type === "crawl"
        ? target.url
        : isSingleScrapeTarget
          ? target.urls[0]
          : null;

    return {
      event_time: eventTime,
      event_type: opts.eventType,
      team_id: opts.teamId,
      monitor_id: opts.monitorId,
      target_id: target.id,
      check_id: opts.checkId ?? null,
      target_type: target.type,
      monitor_status: opts.monitorStatus,
      target_url: targetUrl,
      target_domain: targetUrl ? extractDomain(targetUrl) : null,
      target_signature: monitorTargetSignature(target),
      scrape_url_count: target.type === "scrape" ? target.urls.length : 0,
      crawl_limit:
        target.type === "crawl"
          ? positiveIntegerOrNull(target.crawlOptions?.limit)
          : null,
      crawl_max_depth:
        target.type === "crawl"
          ? unsignedIntegerOrNull(target.crawlOptions?.maxDiscoveryDepth)
          : null,
      schedule_cron: opts.scheduleCron,
      schedule_timezone: opts.scheduleTimezone,
      interval_seconds: intervalSeconds,
      runs_per_day: 86400 / intervalSeconds,
      frequency_bucket: frequencyBucket(intervalSeconds),
      is_active: isActive ? 1 : 0,
      estimated_credits_per_run: estimateMonitorTargetCredits(target),
    };
  });
}

export async function trackMonitorTargetInterest(
  opts: TrackMonitorTargetInterestParams,
): Promise<void> {
  if (opts.zeroDataRetention) return;

  await chInsert(
    "monitor_target_interest_events",
    buildMonitorTargetInterestRows(opts),
  );
}

// =========================================
// Search request tracking
// =========================================

interface TrackSearchRequestParams {
  searchId: string;
  requestId: string;
  teamId: string;
  query: string;
  origin: string;
  kind: string;
  apiVersion: string;
  lang?: string;
  country?: string;
  sources: string[];
  numResults: number;
  searchCredits: number;
  scrapeCredits: number;
  totalCredits: number;
  hasScrapeFormats: boolean;
  scrapeFormats: string[];
  isSuccessful: boolean;
  timeTaken: number;
  zeroDataRetention: boolean;
}

export async function trackSearchRequest(
  opts: TrackSearchRequestParams,
): Promise<void> {
  if (opts.zeroDataRetention) return;

  await chInsert("search_requests", [
    {
      search_id: opts.searchId,
      request_id: opts.requestId,
      team_id: opts.teamId,
      query: opts.query,
      origin: opts.origin,
      kind: opts.kind,
      api_version: opts.apiVersion,
      lang: opts.lang ?? "",
      country: opts.country ?? "",
      sources: opts.sources,
      num_results: opts.numResults,
      search_credits: opts.searchCredits,
      scrape_credits: opts.scrapeCredits,
      total_credits: opts.totalCredits,
      has_scrape_formats: opts.hasScrapeFormats,
      scrape_formats: opts.scrapeFormats,
      is_successful: opts.isSuccessful,
      time_taken: opts.timeTaken,
      created_at: new Date().toISOString(),
    },
  ]);
}

// =========================================
// Search result tracking
// =========================================

interface SearchResultUrl {
  url: string;
  type: "web" | "news" | "image";
  index: number;
}

function extractUrls(response: SearchV2Response): SearchResultUrl[] {
  const urls: SearchResultUrl[] = [];

  if (response.web) {
    for (let i = 0; i < response.web.length; i++) {
      urls.push({ url: response.web[i].url, type: "web", index: i });
    }
  }
  if (response.news) {
    for (let i = 0; i < response.news.length; i++) {
      if (response.news[i].url) {
        urls.push({ url: response.news[i].url!, type: "news", index: i });
      }
    }
  }
  if (response.images) {
    for (let i = 0; i < response.images.length; i++) {
      if (response.images[i].url) {
        urls.push({ url: response.images[i].url!, type: "image", index: i });
      }
    }
  }

  return urls;
}

interface TrackSearchParams {
  searchId: string;
  teamId: string;
  response: SearchV2Response;
  zeroDataRetention: boolean;
  hasScrapeFormats: boolean;
}

export async function trackSearchResults(
  opts: TrackSearchParams,
): Promise<void> {
  if (opts.zeroDataRetention) return;

  const urls = extractUrls(opts.response);
  if (urls.length === 0) return;

  const created_at = new Date().toISOString();

  await chInsert(
    "search_results",
    urls.map(({ url, type, index }) => ({
      search_id: opts.searchId,
      team_id: opts.teamId,
      url,
      url_domain: extractDomain(url),
      result_type: type,
      result_index: index,
      has_scrape_formats: opts.hasScrapeFormats,
      created_at,
    })),
  );
}
