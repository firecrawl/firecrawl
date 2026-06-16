import type {
  SearchPapersOptions,
  SearchPapersResponse,
  GetPaperOptions,
  PaperMetadataResponse,
  ReadPaperResponse,
  SimilarPapersOptions,
  SimilarPapersResponse,
  SearchGithubOptions,
  GitHubSearchResponse,
} from "../types";
import { SdkError } from "../types";
import { HttpClient } from "../utils/httpClient";
import { throwForBadResponse } from "../utils/errorHandler";

const BASE = "/v2/search/research";

/** Append a value (or repeated array values) to a URLSearchParams instance. */
function appendParam(
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | string[] | undefined,
): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (v != null && String(v).length > 0) params.append(key, String(v));
    }
  } else {
    params.append(key, String(value));
  }
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Translate the RFC 7807 Problem body returned by the research service into an
 * SdkError. Falls back to the generic axios normalization otherwise.
 */
function normalizeResearchError(err: any, action: string): never {
  if (err?.isAxiosError) {
    const status: number | undefined = err.response?.status;
    const body: any = err.response?.data;
    if (body && (body.detail || body.title)) {
      const message = body.detail || body.title;
      throw new SdkError(message, status, body.type, body);
    }
    throw new SdkError(
      err.message || `Request failed while trying to ${action}`,
      status,
      err.code,
      body,
    );
  }
  throw err;
}

/**
 * Client for the v2 research endpoints (arXiv papers + GitHub history/readmes).
 * Accessed via `firecrawl.research`.
 */
export class ResearchClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * Search papers by abstract relevance.
   * @param query Natural-language search query.
   * @param options Optional filters (k, authors, categories, from, to).
   */
  async searchPapers(
    query: string,
    options: SearchPapersOptions = {},
  ): Promise<SearchPapersResponse> {
    if (!query || !query.trim()) throw new Error("query cannot be empty");
    if (options.k != null && options.k <= 0)
      throw new Error("k must be positive");
    const params = new URLSearchParams();
    appendParam(params, "query", query);
    appendParam(params, "k", options.k);
    appendParam(params, "authors", options.authors);
    appendParam(params, "categories", options.categories);
    appendParam(params, "from", options.from);
    appendParam(params, "to", options.to);
    try {
      const res = await this.http.get<SearchPapersResponse>(
        withQuery(`${BASE}/papers`, params),
      );
      if (res.status !== 200) throwForBadResponse(res, "search papers");
      return res.data;
    } catch (err) {
      return normalizeResearchError(err, "search papers");
    }
  }

  /**
   * Get paper metadata (detail mode), or read in-body passages (when `query` is
   * supplied). `k` is only valid together with `query`.
   * @param id Paper reference: a canonical `paper_id`, an `arxiv:<id>` key, or a
   *   bare arXiv id / URL.
   * @param options Optional `query` (switches to read mode) and `k`.
   */
  async getPaper(
    id: string,
    options?: { query?: undefined; k?: undefined },
  ): Promise<PaperMetadataResponse>;
  async getPaper(
    id: string,
    options: { query: string; k?: number },
  ): Promise<ReadPaperResponse>;
  async getPaper(
    id: string,
    options: GetPaperOptions = {},
  ): Promise<PaperMetadataResponse | ReadPaperResponse> {
    if (!id || !id.trim()) throw new Error("id cannot be empty");
    if (options.k != null && options.query == null)
      throw new Error("k is only valid together with query");
    if (options.k != null && options.k <= 0)
      throw new Error("k must be positive");
    const params = new URLSearchParams();
    appendParam(params, "query", options.query);
    appendParam(params, "k", options.k);
    try {
      const res = await this.http.get<PaperMetadataResponse | ReadPaperResponse>(
        withQuery(`${BASE}/papers/${encodeURIComponent(id)}`, params),
      );
      if (res.status !== 200) throwForBadResponse(res, "get paper");
      return res.data;
    } catch (err) {
      return normalizeResearchError(err, "get paper");
    }
  }

  /**
   * Find related papers via the citation graph.
   * @param id Primary seed paper reference.
   * @param options Required `intent` plus optional mode, k, rerank, anchor.
   */
  async similarPapers(
    id: string,
    options: SimilarPapersOptions,
  ): Promise<SimilarPapersResponse> {
    if (!id || !id.trim()) throw new Error("id cannot be empty");
    if (!options?.intent || !options.intent.trim())
      throw new Error("intent cannot be empty");
    if (options.k != null && options.k <= 0)
      throw new Error("k must be positive");
    const params = new URLSearchParams();
    appendParam(params, "intent", options.intent);
    appendParam(params, "mode", options.mode);
    appendParam(params, "k", options.k);
    if (options.rerank != null) appendParam(params, "rerank", options.rerank);
    appendParam(params, "anchor", options.anchor);
    try {
      const res = await this.http.get<SimilarPapersResponse>(
        withQuery(
          `${BASE}/papers/${encodeURIComponent(id)}/similar`,
          params,
        ),
      );
      if (res.status !== 200) throwForBadResponse(res, "find similar papers");
      return res.data;
    } catch (err) {
      return normalizeResearchError(err, "find similar papers");
    }
  }

  /**
   * Search GitHub issue/PR history and repository readmes.
   * @param query Search query.
   * @param options Optional `k`.
   */
  async searchGithub(
    query: string,
    options: SearchGithubOptions = {},
  ): Promise<GitHubSearchResponse> {
    if (!query || !query.trim()) throw new Error("query cannot be empty");
    if (options.k != null && options.k <= 0)
      throw new Error("k must be positive");
    const params = new URLSearchParams();
    appendParam(params, "query", query);
    appendParam(params, "k", options.k);
    try {
      const res = await this.http.get<GitHubSearchResponse>(
        withQuery(`${BASE}/github`, params),
      );
      if (res.status !== 200) throwForBadResponse(res, "search github");
      return res.data;
    } catch (err) {
      return normalizeResearchError(err, "search github");
    }
  }
}
