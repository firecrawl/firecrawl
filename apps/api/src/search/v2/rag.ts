import axios from "axios";
import { config } from "../../config";
import { SearchV2Response, RagPassage } from "../../lib/entities";
import { chunkMarkdown, Chunk } from "../../lib/fire-privacy-chunker";
import { Logger } from "winston";

const EMBED_URL = "https://api.deepinfra.com/v1/openai/embeddings";
const EMBED_MODEL = "BAAI/bge-m3";
const CHUNK_MAX_CHARS = 2000;
const TOP_K_PASSAGES = 5;
const EMBED_TIMEOUT_MS = 15000;

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const bi = b[i] ?? 0;
    dot += a[i] * bi;
    normA += a[i] * a[i];
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function selectTopPassages(
  queryEmbedding: number[],
  chunkEmbeddings: number[][],
  chunks: Chunk[],
  k: number,
): RagPassage[] {
  return chunks
    .map((chunk, i) => ({
      text: chunk.text,
      score: cosineSimilarity(queryEmbedding, chunkEmbeddings[i] ?? []),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

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
// Best-effort: per-result failures are logged and skipped. No-op without the
// key or with no scraped markdown.
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

  let queryEmbedding: number[];
  try {
    [queryEmbedding] = await embedTexts([query]);
  } catch (error) {
    logger.warn("RAG query embedding failed; skipping passages", {
      query,
      error: (error as Error)?.message,
    });
    return;
  }

  await Promise.all(
    results.map(async (result, idx) => {
      const source = idx + 1;
      try {
        const chunks = chunkMarkdown(result.markdown!, {
          maxChars: CHUNK_MAX_CHARS,
        });
        if (chunks.length === 0) return;
        const embeddings = await embedTexts(chunks.map(c => c.text));
        result.passages = selectTopPassages(
          queryEmbedding,
          embeddings,
          chunks,
          TOP_K_PASSAGES,
        ).map(p => ({ ...p, source }));
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
