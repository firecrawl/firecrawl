import { Pool } from "pg";
import { createHash } from "crypto";
import { config } from "../../config";
import { embedTexts } from "./rag";
import { Logger } from "winston";

// Persist verified scraped chunks (text + bge-m3 embedding) into pgvector so
// later searches can retrieve them semantically (#6 cache). Uses a direct
// pg.Pool (not Firecrawl's auth-gated `db`) so it works in self-hosted bypass
// mode too. Idempotent DDL; best-effort -- failures are logged, never throw.

let pool: Pool | null = null;
let ensured = false;

function getPool(): Pool | null {
  if (pool) return pool;
  const cs =
    config.DATABASE_URL ??
    `postgresql://${config.POSTGRES_USER}:${config.POSTGRES_PASSWORD}@${config.POSTGRES_HOST}:${config.POSTGRES_PORT}/${config.POSTGRES_DB}`;
  if (!cs) return null;
  pool = new Pool({ connectionString: cs, max: 4 });
  return pool;
}

export async function ensureScrapedChunks(logger: Logger): Promise<boolean> {
  if (ensured) return true;
  const p = getPool();
  if (!p) {
    logger.warn("scraped_chunks: no database connection string");
    return false;
  }
  try {
    await p.query("CREATE EXTENSION IF NOT EXISTS vector");
    await p.query(`
      CREATE TABLE IF NOT EXISTS scraped_chunks (
        id BIGSERIAL PRIMARY KEY,
        url TEXT NOT NULL,
        chunk TEXT NOT NULL,
        embedding vector(1024) NOT NULL,
        source_hash TEXT NOT NULL UNIQUE,
        hhem_score REAL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query(
      "CREATE INDEX IF NOT EXISTS scraped_chunks_embedding_idx ON scraped_chunks USING hnsw (embedding vector_cosine_ops)",
    );
    ensured = true;
    return true;
  } catch (error) {
    logger.warn("ensureScrapedChunks failed", {
      error: (error as Error)?.message,
    });
    return false;
  }
}

// Insert verified chunks with their embeddings. Dedup on source_hash (md5 of
// chunk text) so re-scraping the same page does not duplicate rows.
export async function persistVerifiedChunks(
  items: Array<{ url: string; text: string }>,
  hhemScore: number,
  logger: Logger,
): Promise<void> {
  if (items.length === 0 || !config.DEEPINFRA_API_KEY) return;
  const ok = await ensureScrapedChunks(logger);
  const p = ok ? getPool() : null;
  if (!p) return;
  try {
    const embeddings = await embedTexts(items.map(i => i.text));
    let inserted = 0;
    for (let i = 0; i < items.length; i++) {
      const { url, text } = items[i];
      const sourceHash = createHash("md5").update(text).digest("hex");
      const emb = JSON.stringify(embeddings[i]);
      const res = await p.query(
        "INSERT INTO scraped_chunks (url, chunk, embedding, source_hash, hhem_score) VALUES ($1, $2, $3::vector, $4, $5) ON CONFLICT (source_hash) DO NOTHING",
        [url, text, emb, sourceHash, hhemScore],
      );
      inserted += res.rowCount ?? 0;
    }
    logger.info("Persisted verified chunks", {
      attempted: items.length,
      inserted,
      hhemScore,
    });
  } catch (error) {
    logger.warn("persistVerifiedChunks failed", {
      error: (error as Error)?.message,
    });
  }
}

// Semantic retrieval over persisted chunks for the cache (#6). Returns the
// closest chunks to a query embedding (cosine distance, ascending).
export async function searchScrapedChunks(
  queryEmbedding: number[],
  topK: number,
  logger: Logger,
): Promise<Array<{ url: string; chunk: string; hhemScore: number | null; distance: number }>> {
  const ok = await ensureScrapedChunks(logger);
  const p = ok ? getPool() : null;
  if (!p) return [];
  try {
    const res = await p.query(
      "SELECT url, chunk, hhem_score, embedding <=> $1::vector AS distance FROM scraped_chunks ORDER BY embedding <=> $1::vector LIMIT $2",
      [JSON.stringify(queryEmbedding), topK],
    );
    return res.rows.map(r => ({
      url: r.url,
      chunk: r.chunk,
      hhemScore: r.hhem_score,
      distance: r.distance,
    }));
  } catch (error) {
    logger.warn("searchScrapedChunks failed", {
      error: (error as Error)?.message,
    });
    return [];
  }
}
