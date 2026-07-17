import { Pool } from "pg";
import { createHash } from "crypto";
import { config } from "../../config";
import { embedTexts } from "./rag";
import { GroundedAnswer } from "../../lib/entities";
import { Logger } from "winston";

// Persist verified scraped chunks (text + bge-m3 embedding) into pgvector so
// later searches can retrieve them semantically (#6 cache). Uses a direct
// pg.Pool (not Firecrawl's auth-gated `db`) so it works in self-hosted bypass
// mode too. Idempotent DDL; best-effort -- failures are logged, never throw.

let pool: Pool | null = null;
let ensured = false;
// Cache hit = cosine distance <= this (0.05 ~= 0.95 similarity); ignore rows
// older than this many days.
const CACHE_THRESHOLD = 0.05;
const CACHE_MAX_AGE_DAYS = 7;

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
    await p.query(`
      CREATE TABLE IF NOT EXISTS answer_cache (
        id BIGSERIAL PRIMARY KEY,
        query TEXT NOT NULL,
        query_embedding vector(1024) NOT NULL,
        answer TEXT NOT NULL,
        faithfulness REAL,
        sources JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query(
      "CREATE INDEX IF NOT EXISTS answer_cache_qemb_idx ON answer_cache USING hnsw (query_embedding vector_cosine_ops)",
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

// Pre-search semantic cache: embed the query, find the nearest cached
// answer within the threshold and freshness window. Returns the cached
// GroundedAnswer (cached=true) or null on miss.
export async function checkAnswerCache(
  query: string,
  logger: Logger,
): Promise<GroundedAnswer | null> {
  if (!config.DEEPINFRA_API_KEY) return null;
  const ok = await ensureScrapedChunks(logger);
  const p = ok ? getPool() : null;
  if (!p) return null;
  try {
    const [emb] = await embedTexts([query]);
    const res = await p.query(
      `SELECT answer, faithfulness, sources,
              (query_embedding <=> $1::vector) AS distance
       FROM answer_cache
       WHERE created_at > now() - interval '${CACHE_MAX_AGE_DAYS} days'
       ORDER BY query_embedding <=> $1::vector
       LIMIT 1`,
      [JSON.stringify(emb)],
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    if (row.distance > CACHE_THRESHOLD) return null;
    logger.info("Answer cache hit", { query, distance: row.distance });
    return {
      text: row.answer,
      faithfulness: typeof row.faithfulness === "number" ? row.faithfulness : 0,
      grounded: true,
      sources: Array.isArray(row.sources) ? row.sources : [],
      cached: true,
    } as GroundedAnswer;
  } catch (error) {
    logger.warn("checkAnswerCache failed", {
      error: (error as Error)?.message,
    });
    return null;
  }
}

// Store an accepted answer keyed by its query embedding so a later
// near-duplicate query can be served from cache.
export async function cacheAnswer(
  query: string,
  answer: string,
  faithfulness: number,
  sources: Array<{ n: number; url: string; title: string }>,
  logger: Logger,
): Promise<void> {
  if (!config.DEEPINFRA_API_KEY) return;
  const ok = await ensureScrapedChunks(logger);
  const p = ok ? getPool() : null;
  if (!p) return;
  try {
    const [emb] = await embedTexts([query]);
    await p.query(
      "INSERT INTO answer_cache (query, query_embedding, answer, faithfulness, sources) VALUES ($1, $2::vector, $3, $4, $5)",
      [query, JSON.stringify(emb), answer, faithfulness, JSON.stringify(sources)],
    );
    logger.info("Cached answer", { query, faithfulness });
  } catch (error) {
    logger.warn("cacheAnswer failed", {
      error: (error as Error)?.message,
    });
  }
}
