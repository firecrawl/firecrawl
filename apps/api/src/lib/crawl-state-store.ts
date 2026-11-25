import type IORedis from "ioredis";
import {
  redisCrawlStateConnection,
  redisCrawlStateFallbackConnection,
} from "../services/redis";

const PINNED_MAX = 10_000;
const pinned = new Map<string, IORedis>();

/**
 * Connection that holds crawl `id`'s state. With a fallback store configured,
 * a crawl stays on whichever store holds its document, so moving
 * REDIS_CRAWL_STATE_URL never splits a running crawl across stores. New
 * crawls, and crawls found on neither store, use the primary store. While the
 * fallback store is unreachable, unpinned crawls fail rather than risk a split.
 */
export async function crawlStateStore(id: string): Promise<IORedis> {
  const fallback = redisCrawlStateFallbackConnection;
  if (!fallback) return redisCrawlStateConnection;

  const cached = pinned.get(id);
  if (cached) return cached;

  const store =
    (await redisCrawlStateConnection.exists("crawl:" + id)) === 0 &&
    (await fallback.exists("crawl:" + id)) === 1
      ? fallback
      : redisCrawlStateConnection;

  if (pinned.size >= PINNED_MAX) {
    pinned.delete(pinned.keys().next().value!);
  }
  pinned.set(id, store);
  return store;
}

/** Every configured crawl state store, primary first. */
export function crawlStateStores(): IORedis[] {
  return redisCrawlStateFallbackConnection
    ? [redisCrawlStateConnection, redisCrawlStateFallbackConnection]
    : [redisCrawlStateConnection];
}
