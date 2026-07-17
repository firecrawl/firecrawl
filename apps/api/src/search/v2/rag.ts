import axios from "axios";
import { config } from "../../config";
import { SearchV2Response, RagPassage } from "../../lib/entities";
import { chunkMarkdown } from "../../lib/fire-privacy-chunker";
import { rerankTexts } from "./reranker";
import { Logger } from "winston";

const EMBED_URL = "https://api.deepinfra.com/v1/openai/embeddings";
const EMBED_MODEL = "BAAI/bge-m3";
const CHUNK_MAX_CHARS = 2000;
const TOP_K_PASSAGES = 5;
const EMBED_TIMEOUT_MS = 15000;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const response = await axios.post(
      EMBED_URL,
      { model: EMBED_MODEL, input: texts },
      {
        headers: {
          Authorization: `Bearer ${config.DEEPINFRA_API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      },
    );
    const data = response.data?.data;
    if (!Array.isArray(data)) {
      throw new Error("embeddings response missing data array");
    }
    return data.map((d: any) => d.embedding);
  } finally {
    clearTimeout(handle);
  }
}

// Attach the top-k most query-relevant passages to each scraped web result.
// Uses the SAME cross-encoder (Qwen3-Reranker) as page selection -- chunk
// selection must not use a weaker method than page selection.
// Best-effort: per-result failures are logged and skipped.
export async function attachRagPassages(
  searchResponse: SearchV2Response,
  query: string,
  logger: Logger,
): Promise<void> {
  if (!config.DEEPINFRA_API_KEY) {
    logger.warn("RAG passages skipped: DEEPINFRA_API_KEY not set");
    return;
  }
  const results = (searchResponse.web ?? []).filter(r => r.markdown);
  if (results.length === 0) return;

  await Promise.all(
    results.map(async (result, idx) => {
      const source = idx + 1;
      try {
        const chunks = chunkMarkdown(result.markdown!, {
          maxChars: CHUNK_MAX_CHARS,
        });
        if (chunks.length === 0) return;
        const scores = await rerankTexts(
          query,
          chunks.map(c => c.text),
          logger,
        );
        if (!scores) return;
        result.passages = chunks
          .map(
            (c, i) =>
              ({
                text: c.text,
                score: scores[i] ?? -Infinity,
                source,
              }) as RagPassage,
          )
          .sort((a, b) => b.score - a.score)
          .slice(0, TOP_K_PASSAGES);
      } catch (error) {
        logger.warn("RAG passages failed for result; skipping", {
          url: result.url,
          error: (error as Error)?.message,
        });
      }
    }),
  );
  logger.info("Attached RAG passages", {
    query,
    results: results.length,
  });
}
