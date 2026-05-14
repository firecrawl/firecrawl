import {
  type Document,
  type SearchData,
  type SearchRequest,
  type SearchResponse,
  type SearchResultWeb,
  type ScrapeOptions,
  type SearchResultNews,
  type SearchResultImages,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import { ensureValidScrapeOptions } from "../utils/validation";
import {
  throwForBadResponse,
  normalizeAxiosError,
} from "../utils/errorHandler";

function prepareSearchPayload(req: SearchRequest): Record<string, unknown> {
  if (!req.query || !req.query.trim()) throw new Error("Query cannot be empty");
  if (req.limit != null && req.limit <= 0)
    throw new Error("limit must be positive");
  if (req.timeout != null && req.timeout <= 0)
    throw new Error("timeout must be positive");
  if (req.includeDomains?.length && req.excludeDomains?.length)
    throw new Error(
      "includeDomains and excludeDomains cannot both be specified",
    );
  const payload: Record<string, unknown> = {
    query: req.query,
  };
  if (req.sources) payload.sources = req.sources;
  if (req.categories) payload.categories = req.categories;
  if (req.includeDomains) payload.includeDomains = req.includeDomains;
  if (req.excludeDomains) payload.excludeDomains = req.excludeDomains;
  if (req.limit != null) payload.limit = req.limit;
  if (req.tbs != null) payload.tbs = req.tbs;
  if (req.location != null) payload.location = req.location;
  if (req.ignoreInvalidURLs != null)
    payload.ignoreInvalidURLs = req.ignoreInvalidURLs;
  if (req.timeout != null) payload.timeout = req.timeout;
  if (req.integration && req.integration.trim())
    payload.integration = req.integration.trim();
  if (req.origin) payload.origin = req.origin;
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

interface RawSearchResponse {
  success: boolean;
  data?: Record<string, unknown>;
  id?: string;
  creditsUsed?: number;
  warning?: string | null;
  error?: string;
}

function transformSearchData(raw: Record<string, any>): SearchData {
  const out: SearchData = {};
  if (raw.web) out.web = transformArray<SearchResultWeb>(raw.web);
  if (raw.news) out.news = transformArray<SearchResultNews>(raw.news);
  if (raw.images) out.images = transformArray<SearchResultImages>(raw.images);
  return out;
}

async function executeSearch(
  http: HttpClient,
  request: SearchRequest,
): Promise<RawSearchResponse> {
  const payload = prepareSearchPayload(request);
  try {
    const res = await http.post<RawSearchResponse>(
      "/v2/search",
      payload,
      typeof request.timeout === "number"
        ? { timeoutMs: request.timeout + 5000 }
        : {},
    );
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "search");
    }
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "search");
    throw err;
  }
}

export async function search(
  http: HttpClient,
  request: SearchRequest,
): Promise<SearchData> {
  const raw = await executeSearch(http, request);
  return transformSearchData((raw.data || {}) as Record<string, any>);
}

export async function searchWithMetadata(
  http: HttpClient,
  request: SearchRequest,
): Promise<SearchResponse> {
  const raw = await executeSearch(http, request);
  const response: SearchResponse = {
    data: transformSearchData((raw.data || {}) as Record<string, any>),
  };
  if (raw.id !== undefined) response.id = raw.id;
  if (raw.creditsUsed !== undefined) response.creditsUsed = raw.creditsUsed;
  if (raw.warning !== undefined) response.warning = raw.warning;
  return response;
}
