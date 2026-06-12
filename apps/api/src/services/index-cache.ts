import crypto from "crypto";
import IORedis from "ioredis";
import { config } from "../config";
import { logger as _logger } from "../lib/logger";
import {
  indexCacheErrorCounter,
  indexCacheReadDuration,
} from "../lib/index-cache-metrics";
import type { Logger } from "winston";

// Dragonfly LRU cache in front of the index database's URL->id lookup hot
// path (index_get_recent_5) and the per-domain max age lookup (query_max_age).
// The instance runs with --cache_mode=true, so memory pressure evicts cold
// keys; TTLs here are hygiene, not correctness. Invalidation of index entries
// (invalidated_at) is a rare manual ops action handled by flushing the whole
// instance.

const ENTRY_KEY_PREFIX = "idxc:";
const MAX_AGE_KEY_PREFIX = "idxma:";
const ENTRY_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_AGE_TTL_SECONDS = 15 * 60;
// More entries than index_get_recent_5's LIMIT 5 so that client-side
// filtering on screenshot/waitFor/minAge still has headroom to find 5 rows.
const ENTRY_CAP = 32;
const READ_TIMEOUT_MS = 150;

const indexCacheRedis: IORedis | null = config.INDEX_CACHE_REDIS_URL
  ? new IORedis(config.INDEX_CACHE_REDIS_URL, {
      enableAutoPipelining: true,
      // The cache must fail fast and fall back to Postgres, never queue
      // commands while disconnected.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    })
  : null;

indexCacheRedis?.on("error", error => {
  _logger.warn("Index cache Redis connection error", {
    module: "index-cache",
    error,
  });
});

export const useIndexCache = indexCacheRedis !== null;

export type IndexCacheEntry = {
  id: string;
  created_at: string;
  status: number;
  has_screenshot: boolean;
  has_screenshot_fullscreen: boolean;
  wait_time_ms: number | null;
};

type IndexCacheReadResult =
  | { status: "hit"; entries: IndexCacheEntry[] }
  | { status: "miss" }
  | { status: "error" };

// Exact-match dimensions of index_get_recent_5. Range/capability dimensions
// (age window, screenshot capability, wait_time_ms) live on the entries and
// are applied by filterIndexEntries. Languages are sorted+deduped because the
// SQL compares them with set semantics (@> and <@); empty array and null stay
// distinct because the SQL treats them differently (IS NULL vs set equality).
export function deriveIndexVariantKey(params: {
  urlHash: Buffer;
  isMobile: boolean;
  blockAds: boolean;
  isStealth: boolean;
  locationCountry: string | null;
  locationLanguages: string[] | null;
}): string {
  const languages =
    params.locationLanguages === null
      ? null
      : [...new Set(params.locationLanguages)].sort();
  const payload = JSON.stringify([
    params.urlHash.toString("hex"),
    params.isMobile,
    params.blockAds,
    params.isStealth,
    params.locationCountry,
    languages,
  ]);
  return (
    ENTRY_KEY_PREFIX + crypto.createHash("sha256").update(payload).digest("hex")
  );
}

// Mirrors the per-entry filters of index_get_recent_5 (see PR description for
// the SQL source): age window, screenshot capability (a request that doesn't
// need a screenshot matches any entry; one that does requires it), waitFor
// (COALESCE(entry, 0) >= requested), newest-first, LIMIT 5. Keep in sync with
// the SQL function.
export function filterIndexEntries(
  entries: IndexCacheEntry[],
  opts: {
    maxAgeMs: number;
    minAgeMs: number | null;
    needsScreenshot: boolean;
    needsScreenshotFullscreen: boolean;
    waitTimeMs: number | null;
    now?: number;
  },
): IndexCacheEntry[] {
  const now = opts.now ?? Date.now();
  return entries
    .filter(entry => {
      const createdAt = new Date(entry.created_at).getTime();
      if (isNaN(createdAt)) return false;
      if (createdAt < now - opts.maxAgeMs) return false;
      if (opts.minAgeMs !== null && createdAt > now - opts.minAgeMs)
        return false;
      if (opts.needsScreenshot && !entry.has_screenshot) return false;
      if (opts.needsScreenshotFullscreen && !entry.has_screenshot_fullscreen)
        return false;
      if (
        opts.waitTimeMs !== null &&
        (entry.wait_time_ms ?? 0) < opts.waitTimeMs
      )
        return false;
      return true;
    })
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, 5);
}

const TIMED_OUT = Symbol("index-cache-timeout");

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>(resolve =>
      setTimeout(() => resolve(TIMED_OUT), ms).unref?.(),
    ),
  ]);
}

export async function getCachedIndexEntries(
  key: string,
  logger: Logger = _logger,
  client: IORedis | null = indexCacheRedis,
): Promise<IndexCacheReadResult> {
  if (client === null) {
    return { status: "error" };
  }
  const start = Date.now();
  try {
    const raw = await withTimeout(client.hgetall(key), READ_TIMEOUT_MS);
    indexCacheReadDuration.observe((Date.now() - start) / 1000);
    if (raw === TIMED_OUT) {
      indexCacheErrorCounter.inc({ op: "read_timeout" });
      return { status: "error" };
    }
    const fields = Object.values(raw);
    if (fields.length === 0) {
      return { status: "miss" };
    }
    const entries: IndexCacheEntry[] = [];
    for (const field of fields) {
      try {
        entries.push(JSON.parse(field));
      } catch {
        // Skip unparseable entries; they age out via TTL/eviction.
      }
    }
    if (entries.length === 0) {
      return { status: "miss" };
    }
    return { status: "hit", entries };
  } catch (error) {
    indexCacheReadDuration.observe((Date.now() - start) / 1000);
    indexCacheErrorCounter.inc({ op: "read" });
    logger.warn("Index cache read failed", {
      module: "index-cache",
      error,
      key,
    });
    return { status: "error" };
  }
}

export async function upsertCachedIndexEntries(
  key: string,
  entries: IndexCacheEntry[],
  logger: Logger = _logger,
  client: IORedis | null = indexCacheRedis,
): Promise<void> {
  if (client === null || entries.length === 0) {
    return;
  }
  try {
    const fields: Record<string, string> = {};
    for (const entry of entries) {
      fields[entry.id] = JSON.stringify(entry);
    }
    const pipeline = client.pipeline();
    pipeline.hset(key, fields);
    pipeline.expire(key, ENTRY_TTL_SECONDS);
    pipeline.hlen(key);
    const results = await pipeline.exec();
    const hlen = results?.[2]?.[1];
    if (typeof hlen === "number" && hlen > ENTRY_CAP) {
      const raw = await client.hgetall(key);
      const parsed = Object.entries(raw)
        .map(([id, field]) => {
          try {
            return { id, created_at: JSON.parse(field).created_at as string };
          } catch {
            return { id, created_at: "1970-01-01T00:00:00Z" };
          }
        })
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
      const toDelete = parsed.slice(ENTRY_CAP).map(x => x.id);
      if (toDelete.length > 0) {
        await client.hdel(key, ...toDelete);
      }
    }
  } catch (error) {
    indexCacheErrorCounter.inc({ op: "write" });
    logger.warn("Index cache write failed", {
      module: "index-cache",
      error,
      key,
    });
  }
}

export async function deleteCachedIndexEntry(
  key: string,
  id: string,
  logger: Logger = _logger,
  client: IORedis | null = indexCacheRedis,
): Promise<void> {
  if (client === null) {
    return;
  }
  try {
    await client.hdel(key, id);
  } catch (error) {
    indexCacheErrorCounter.inc({ op: "delete" });
    logger.warn("Index cache entry delete failed", {
      module: "index-cache",
      error,
      key,
      id,
    });
  }
}

// Caches query_max_age results per domain hash, including the "no signature"
// (null) result so absent domains don't keep hitting Postgres.
export async function getCachedMaxAge(
  domainHash: Buffer,
  logger: Logger = _logger,
  client: IORedis | null = indexCacheRedis,
): Promise<{ maxAge: number | null } | null> {
  if (client === null) {
    return null;
  }
  try {
    const raw = await withTimeout(
      client.get(MAX_AGE_KEY_PREFIX + domainHash.toString("hex")),
      READ_TIMEOUT_MS,
    );
    if (raw === TIMED_OUT) {
      indexCacheErrorCounter.inc({ op: "maxage_read_timeout" });
      return null;
    }
    if (raw === null || raw === undefined) {
      return null;
    }
    return { maxAge: JSON.parse(raw).max_age ?? null };
  } catch (error) {
    indexCacheErrorCounter.inc({ op: "maxage_read" });
    logger.warn("Index cache max age read failed", {
      module: "index-cache",
      error,
    });
    return null;
  }
}

export async function setCachedMaxAge(
  domainHash: Buffer,
  maxAge: number | null,
  logger: Logger = _logger,
  client: IORedis | null = indexCacheRedis,
): Promise<void> {
  if (client === null) {
    return;
  }
  try {
    await client.set(
      MAX_AGE_KEY_PREFIX + domainHash.toString("hex"),
      JSON.stringify({ max_age: maxAge }),
      "EX",
      MAX_AGE_TTL_SECONDS,
    );
  } catch (error) {
    indexCacheErrorCounter.inc({ op: "maxage_write" });
    logger.warn("Index cache max age write failed", {
      module: "index-cache",
      error,
    });
  }
}
