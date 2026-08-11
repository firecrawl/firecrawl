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
import { getVersion } from "../utils/getVersion";

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
  // Research endpoints are GETs, so the POST-body origin injection in
  // HttpClient never applies — attach it as a query param instead.
  params.append("origin", `js-sdk@${getVersion()}`);
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
 * Client for the v2 research endpoints — Firecrawl's **research paper index**
 * (~43M paper abstracts) plus GitHub history/readmes.
 *
 * The paper corpus is roughly 90% biomedical and life sciences — PubMed,
 * bioRxiv and medRxiv — with arXiv covering physics, mathematics and computer
 * science. Supports abstract search, paper metadata, in-body passage reads and
 * citation-graph expansion.
 *
 * ⚠️ This is **not** the same as `search({ categories: ["research"] })`. That
 * option is a website/domain filter on ordinary web search: it narrows
 * Google-style results to ~14 academic domains and returns page snippets. The
 * methods here query the paper index itself and return ranked paper records.
 *
 * Accessed via `firecrawl.research`.
 *
 * @example
 * ```ts
 * const res = await firecrawl.research.searchPapers(
 *   "tau aggregation inhibitors in Alzheimer's disease",
 *   { k: 10 },
 * );
 * ```
 */
export class ResearchClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * Search the research paper index by abstract relevance.
   *
   * Queries ~43M paper abstracts: PubMed, bioRxiv and medRxiv (about 90% of the
   * corpus — biomedical and life sciences) plus arXiv (physics, mathematics,
   * computer science). Semantic search over abstracts, not keyword matching.
   *
   * This is **not** `search({ categories: ["research"] })`, which only narrows
   * ordinary web search to ~14 academic websites.
   *
   * @param query Natural-language search query, e.g. `"CRISPR base editing
   *   off-target effects in primary human T cells"`.
   * @param options Optional filters (k, authors, categories, from, to). Note
   *   `categories` here filters *paper* subject categories (e.g. `"q-bio.GN"`)
   *   and is unrelated to the `categories` option of `search()`.
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
   * @param id Paper reference: a canonical `paperId`, or a namespaced id key
   *   such as `pmid:<id>`, `pmcid:<id>`, `doi:<doi>` or `arxiv:<id>`. Bare
   *   arXiv ids and arXiv URLs are also accepted.
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
