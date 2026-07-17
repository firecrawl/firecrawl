import axios from "axios";
import { config } from "../../config";
import { WebSearchResult } from "../../lib/entities";
import { Logger } from "winston";

// DeepInfra hosts Qwen3-Reranker-4B (verified: the only reranker in their
// catalog). Request: { queries:[q], documents:[...], top_n }. Response:
// { scores:[...] } aligned with the documents array (document order, not
// sorted) -- we reorder client-side.
const DEEPINFRA_RERANK_URL =
  "https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-4B";
const RERANK_TIMEOUT_MS = 8000;
const RERANK_MAX_RETRIES = 1;

export function buildRerankDocument(result: WebSearchResult): string {
  return [result.title, result.description].filter(Boolean).join(" \n ");
}

// scores[i] aligns with the documents array passed in. Sort descending; a
// missing score sorts last (-Infinity) so a malformed response cannot promote
// an unscored result.
export function reorderResultsByScores(
  results: WebSearchResult[],
  scores: Array<number | undefined>,
): WebSearchResult[] {
  return results
    .map((result, i) => ({
      result,
      score: typeof scores[i] === "number" ? (scores[i] as number) : -Infinity,
    }))
    .sort((a, b) => b.score - a.score)
    .map(p => p.result);
}

// Score raw text documents against a query with the Qwen3 cross-encoder.
// Returns scores aligned with the input texts (document order), or null on any
// failure. Same model used for page rerank -- chunk selection must not use a
// weaker method than page selection.
export async function rerankTexts(
  query: string,
  texts: string[],
  logger: Logger,
): Promise<number[] | null> {
  if (!config.DEEPINFRA_API_KEY || texts.length === 0) return null;
  for (let attempt = 0; attempt <= RERANK_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const handle = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
    try {
      const response = await axios.post(
        DEEPINFRA_RERANK_URL,
        { queries: [query], documents: texts, top_n: texts.length },
        {
          headers: {
            Authorization: `Bearer ${config.DEEPINFRA_API_KEY}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
      );
      const scores = response.data?.scores;
      if (Array.isArray(scores) && scores.length === texts.length) {
        return scores as number[];
      }
      logger.warn("rerankTexts: unexpected shape", {
        query,
        scoreCount: Array.isArray(scores) ? scores.length : "non-array",
      });
      return null;
    } catch (error) {
      const e = error as { code?: string; response?: { status?: number } };
      const transient =
        e.code === "ERR_CANCELED" ||
        e.code === "ERR_NETWORK" ||
        (typeof e.response?.status === "number" && e.response.status >= 500);
      if (!transient || attempt === RERANK_MAX_RETRIES) {
        logger.warn("rerankTexts failed", {
          query,
          code: e.code,
          status: e.response?.status,
        });
        return null;
      }
    } finally {
      clearTimeout(handle);
    }
  }
  return null;
}

// Always-on rerank for web results. Reranking is an ordering optimisation: on
// any failure (no key, timeout, bad shape) the original SearXNG order is kept
// and the failure is logged at warn -- never silently swallowed.
export async function rerankWebResults(
  query: string,
  results: WebSearchResult[],
  logger: Logger,
): Promise<WebSearchResult[]> {
  if (!config.DEEPINFRA_API_KEY) {
    logger.warn("Reranking skipped: DEEPINFRA_API_KEY not set");
    return results;
  }
  if (results.length <= 1) return results;

  const documents = results.map(buildRerankDocument);

  for (let attempt = 0; attempt <= RERANK_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const handle = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
    try {
      const response = await axios.post(
        DEEPINFRA_RERANK_URL,
        { queries: [query], documents, top_n: documents.length },
        {
          headers: {
            Authorization: `Bearer ${config.DEEPINFRA_API_KEY}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
      );
      const scores = response.data?.scores;
      if (Array.isArray(scores) && scores.length === results.length) {
        logger.info("Reranked web results", {
          query,
          count: results.length,
          topScore: scores[0],
        });
        return reorderResultsByScores(results, scores as number[]);
      }
      logger.warn("Reranker returned unexpected shape; keeping order", {
        query,
        scoreCount: Array.isArray(scores) ? scores.length : "non-array",
        resultCount: results.length,
      });
      return results;
    } catch (error) {
      const e = error as {
        code?: string;
        response?: { status?: number };
        message?: string;
      };
      const status = e?.response?.status;
      const code = e?.code;
      const transient =
        code === "ERR_CANCELED" ||
        code === "ERR_NETWORK" ||
        (typeof status === "number" && status >= 500);
      if (!transient || attempt === RERANK_MAX_RETRIES) {
        logger.warn("Reranking failed; keeping original order", {
          query,
          code,
          status,
          message: e?.message,
        });
        return results;
      }
    } finally {
      clearTimeout(handle);
    }
  }
  return results;
}
