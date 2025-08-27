import { type Document, type SearchData, type SearchRequest, type SearchResultWeb, type ScrapeOptions, type SearchResultNews, type SearchResultImages } from "../types";
import { HttpClient } from "../utils/httpClient";
import { ensureValidScrapeOptions } from "../utils/validation";
import { throwForBadResponse, normalizeAxiosError } from "../utils/errorHandler";

function prepareSearchPayload(req: SearchRequest): Record<string, unknown> {
  if (!req.query || !req.query.trim()) throw new Error("Query cannot be empty");
  if (req.limit != null && req.limit <= 0) throw new Error("limit must be positive");
  if (req.timeout != null && req.timeout <= 0) throw new Error("timeout must be positive");
  const payload: Record<string, unknown> = {
    query: req.query,
  };
  if (req.sources) payload.sources = req.sources;
  if (req.categories) payload.categories = req.categories;
  if (req.limit != null) payload.limit = req.limit;
  if (req.tbs != null) payload.tbs = req.tbs;
  if (req.location != null) payload.location = req.location;
  if (req.ignoreInvalidURLs != null) payload.ignoreInvalidURLs = req.ignoreInvalidURLs;
  if (req.timeout != null) payload.timeout = req.timeout;
  if (req.scrapeOptions) {
    ensureValidScrapeOptions(req.scrapeOptions as ScrapeOptions);
    payload.scrapeOptions = req.scrapeOptions;
  }
  return payload;
}

function transformArray<ResultType>(arr: any[]): Array<ResultType | Document> {
  const results: Array<ResultType | Document> = [] as any;
  for (const item of arr) {
    if (item && typeof item === "object") {
      if (
        "markdown" in item ||
        "html" in item ||
        "rawHtml" in item ||
        "links" in item ||
        "screenshot" in item ||
        "changeTracking" in item ||
        "summary" in item ||
        "json" in item
      ) {
        results.push(item as Document);
      } else {
        results.push(item as ResultType);
      }
    } else {
      results.push({ url: item } as ResultType);
    }
  }
  return results;
}

export async function search(http: HttpClient, request: SearchRequest): Promise<SearchData> {
  const payload = prepareSearchPayload(request);
  try {
    const res = await http.post<{ success: boolean; data?: Record<string, unknown>; error?: string }>("/v2/search", payload);
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "search");
    }
    const data = (res.data.data || {}) as Record<string, any>;
    const out: SearchData = {};
    if (data.web) out.web = transformArray<SearchResultWeb>(data.web);
    if (data.news) out.news = transformArray<SearchResultNews>(data.news);
    if (data.images) out.images = transformArray<SearchResultImages>(data.images);
    return out;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "search");
    throw err;
  }
}

