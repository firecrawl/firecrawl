import { chInsert } from "./clickhouse-client";
import type { SearchV2Response } from "./entities";

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
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
// Search tracking
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
