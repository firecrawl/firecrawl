import type { Logger } from "winston";
import { config } from "../config";
import { WebSearchResult } from "../lib/entities";

const ARXIV_COLLECTION = "arxiv_abstracts_v1";
const ARXIV_RERANKER = "8b";

interface ArxivApiResult {
  arxiv_id?: string;
  title?: string;
  abstract?: string;
  text?: string;
  authors?: string;
  categories?: string;
  update_date?: string;
  created_date?: string;
}

interface SearchArxivOptions {
  query: string;
  limit: number;
  logger: Logger;
  timeoutMs?: number;
}

function buildArxivUrl(opts: {
  base: string;
  query: string;
  topK: number;
  candidates: number;
}): string {
  const url = new URL(opts.base);
  url.searchParams.set("q", opts.query);
  url.searchParams.set("collection", ARXIV_COLLECTION);
  url.searchParams.set("top_k", String(opts.topK));
  url.searchParams.set("candidates", String(opts.candidates));
  url.searchParams.set("reranker", ARXIV_RERANKER);
  return url.toString();
}

function mapArxivResult(
  result: ArxivApiResult,
  position: number,
): WebSearchResult | null {
  if (!result.arxiv_id) {
    return null;
  }

  const url = `https://arxiv.org/abs/${result.arxiv_id}`;
  const title = result.title?.trim() || result.arxiv_id;
  // Prefer the abstract for the short description; fall back to the text field if needed.
  const description = (result.abstract || result.text || "").trim();

  return {
    url,
    title,
    description,
    position,
    category: "arxiv",
    metadata: {
      arxivId: result.arxiv_id,
      authors: result.authors,
      arxivCategories: result.categories,
      updateDate: result.update_date,
      createdDate: result.created_date,
    },
  };
}

/**
 * Queries the internal arxiv search API and returns `WebSearchResult`s
 * tagged with `category: "arxiv"`. Any failure (network, HTTP, parse) is
 * swallowed and logged — callers should treat this as best-effort.
 *
 * When `ARXIV_SEARCH_URL` is not configured the function logs an info
 * message and returns an empty array so the rest of the search pipeline
 * continues to work.
 */
export async function searchArxiv({
  query,
  limit,
  logger,
  timeoutMs = 10000,
}: SearchArxivOptions): Promise<WebSearchResult[]> {
  if (!query.trim()) {
    return [];
  }

  const base = config.ARXIV_SEARCH_URL;
  if (!base) {
    logger.info(
      "Arxiv category requested but ARXIV_SEARCH_URL is not configured; skipping",
    );
    return [];
  }

  const topK = Math.max(1, Math.min(limit, 100));
  const candidates = Math.max(50, topK * 10);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Kept inside the try block so a malformed `ARXIV_SEARCH_URL` (which
    // makes `new URL()` throw) is handled like any other arxiv failure
    // instead of rejecting the whole search request.
    const url = buildArxivUrl({ base, query, topK, candidates });

    logger.info("Calling arxiv search API", { topK, candidates });

    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("Arxiv search API returned non-200 status", {
        status: response.status,
      });
      return [];
    }

    const data = (await response.json()) as { results?: ArxivApiResult[] };
    const hits = Array.isArray(data.results) ? data.results : [];

    const mapped: WebSearchResult[] = [];
    for (const hit of hits) {
      const r = mapArxivResult(hit, mapped.length + 1);
      if (r) mapped.push(r);
      if (mapped.length >= limit) break;
    }

    logger.info("Arxiv search API returned results", {
      returned: mapped.length,
      requested: topK,
    });

    return mapped;
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" || error.message.includes("aborted"));
    logger.warn("Arxiv search API call failed", {
      error: error instanceof Error ? error.message : String(error),
      aborted: isAbort,
    });
    return [];
  } finally {
    clearTimeout(timer);
  }
}
