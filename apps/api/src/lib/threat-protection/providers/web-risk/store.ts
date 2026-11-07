import { config } from "../../../../config";
import { getRedisConnection } from "../../../../services/queue-service";

// Redis-backed store for the locally synced Google Web Risk threat lists
// (hash prefixes, Update API — see ./sync.ts). Design constraints:
//
//  * Lives in the durable, NON-EVICTING Redis (config.REDIS_URL via
//    getRedisConnection()) — explicitly not the evict or rate-limit
//    connections: the lists are operational data that must not be evicted
//    under memory pressure. (This data is Google's threat lists, not
//    anything scrape-derived — storing it is ZDR-compatible.)
//
//  * Memory-efficient layout: ~5M 4-byte prefixes as individual SET members
//    would balloon ~20MB of raw data into hundreds of MB of per-entry
//    overhead. Instead, prefixes are sharded by their leading 12 bits into
//    4096 buckets, each bucket one binary string of sorted, concatenated
//    4-byte prefixes. Membership = one MGET + a local binary search.
//    (Rare longer entries — the protocol allows 4-32 byte prefixes — go into
//    a per-version "long" key, checked by prefix comparison.)
//
//  * Versioned namespaces with an atomic pointer swap: a sync writes every
//    bucket under a fresh version id, then flips the version pointer in a
//    single SET — a partially written version is never served. Old versions
//    are expired with a short grace period so in-flight readers that already
//    resolved the old pointer still find their buckets.

export const WEB_RISK_THREAT_TYPES = [
  "MALWARE",
  "SOCIAL_ENGINEERING",
  "UNWANTED_SOFTWARE",
] as const;

export type WebRiskThreatType = (typeof WEB_RISK_THREAT_TYPES)[number];

const BUCKET_BITS = 12;
const BUCKET_COUNT = 1 << BUCKET_BITS;
// Refreshed on every sync; prevents orphaned lists from lingering forever if
// syncing is disabled/abandoned. Staleness (hours) cuts in far earlier.
const KEY_TTL_SECONDS = 7 * 24 * 60 * 60;
// How long a superseded version's keys stay readable after the pointer swap.
const OLD_VERSION_GRACE_SECONDS = 300;

export interface ThreatListMeta {
  /** Google's versionToken for the stored list state, base64. */
  versionToken: string;
  /** sha256 (base64) over the sorted concatenated entries, per protocol. */
  checksum: string;
  /** Number of stored entries (hash prefixes). */
  count: number;
  /** When this version was written (ISO timestamp). */
  syncedAt: string;
  /** Earliest time the next computeDiff should run (ISO timestamp). */
  nextDiffAt: string;
}

interface ListPointer {
  version: string;
  meta: ThreatListMeta;
}

interface WebRiskPrefixHit {
  threatType: WebRiskThreatType;
  /** The stored entry that matched (a prefix of `fullHash`), 4-32 bytes. */
  prefix: Buffer;
  fullHash: Buffer;
}

export type WebRiskLookupResult =
  | { status: "unavailable" }
  | { status: "stale"; ageSeconds: number }
  | { status: "ok"; hits: WebRiskPrefixHit[] };

/** Minimal ioredis surface the store needs (kept narrow for unit testing). */
export interface WebRiskRedis {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  mgetBuffer(...keys: string[]): Promise<(Buffer | null)[]>;
  set(
    key: string,
    value: string | Buffer,
    ...args: (string | number)[]
  ): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

const pointerKey = (type: WebRiskThreatType) => `threat_list:${type}:current`;
const bucketKey = (type: WebRiskThreatType, version: string, bucket: number) =>
  `threat_list:${type}:${version}:b:${bucket}`;
const longKey = (type: WebRiskThreatType, version: string) =>
  `threat_list:${type}:${version}:long`;

function bucketIndex(entry: Buffer): number {
  return (entry[0] << 4) | (entry[1] >> 4);
}

/** Binary search for a 4-byte prefix in a sorted concatenated bucket. */
function bucketContains(bucket: Buffer, prefix: Buffer): boolean {
  const target = prefix.readUInt32BE(0);
  let lo = 0;
  let hi = bucket.length / 4 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = bucket.readUInt32BE(mid * 4);
    if (value === target) return true;
    if (value < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Serialize length-prefixed long (>4 byte) entries. */
function encodeLongEntries(entries: Buffer[]): Buffer {
  return Buffer.concat(
    entries.flatMap(entry => [Buffer.from([entry.length]), entry]),
  );
}

function decodeLongEntries(blob: Buffer): Buffer[] {
  const entries: Buffer[] = [];
  let offset = 0;
  while (offset < blob.length) {
    const length = blob[offset];
    entries.push(blob.subarray(offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  return entries;
}

export class WebRiskListStore {
  constructor(private readonly redis: WebRiskRedis) {}

  private parsePointer(raw: string | null): ListPointer | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ListPointer;
      if (
        typeof parsed?.version !== "string" ||
        typeof parsed?.meta?.syncedAt !== "string"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async getPointer(type: WebRiskThreatType): Promise<ListPointer | null> {
    return this.parsePointer(await this.redis.get(pointerKey(type)));
  }

  async getPointers(): Promise<Map<WebRiskThreatType, ListPointer | null>> {
    const raw = await this.redis.mget(
      ...WEB_RISK_THREAT_TYPES.map(type => pointerKey(type)),
    );
    return new Map(
      WEB_RISK_THREAT_TYPES.map((type, i) => [type, this.parsePointer(raw[i])]),
    );
  }

  /**
   * Loads the full sorted entry list for a stored version (used by the sync
   * worker to apply an incremental diff — removal indices reference positions
   * in this lexicographically sorted list).
   */
  async loadEntries(
    type: WebRiskThreatType,
    version: string,
  ): Promise<Buffer[]> {
    const keys: string[] = [];
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      keys.push(bucketKey(type, version, bucket));
    }
    keys.push(longKey(type, version));

    const CHUNK = 512;
    const values: (Buffer | null)[] = [];
    for (let i = 0; i < keys.length; i += CHUNK) {
      values.push(
        ...(await this.redis.mgetBuffer(...keys.slice(i, i + CHUNK))),
      );
    }

    const shortEntries: Buffer[] = [];
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      const blob = values[bucket];
      if (!blob) continue;
      for (let offset = 0; offset < blob.length; offset += 4) {
        shortEntries.push(blob.subarray(offset, offset + 4));
      }
    }
    const longBlob = values[BUCKET_COUNT];
    const longEntries = longBlob ? decodeLongEntries(longBlob) : [];

    // Buckets are globally sorted already; merge in the (sorted) long entries.
    if (longEntries.length === 0) return shortEntries;
    return [...shortEntries, ...longEntries].sort(Buffer.compare);
  }

  /**
   * Writes a full list snapshot under a fresh version id and atomically swaps
   * the version pointer to it. `entries` must be lexicographically sorted.
   * Returns the new version id.
   */
  async writeVersion(
    type: WebRiskThreatType,
    entries: Buffer[],
    meta: ThreatListMeta,
  ): Promise<string> {
    const previous = await this.getPointer(type);
    const version = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const buckets: Buffer[][] = [];
    const long: Buffer[] = [];
    for (const entry of entries) {
      if (entry.length === 4) {
        const index = bucketIndex(entry);
        (buckets[index] ??= []).push(entry);
      } else {
        long.push(entry);
      }
    }

    // ioredis pipelines synchronously issued commands on the socket, so a
    // Promise.all of SETs is one batched round trip in practice.
    const writes: Promise<unknown>[] = [];
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      const content = buckets[bucket];
      if (!content || content.length === 0) continue;
      writes.push(
        this.redis.set(
          bucketKey(type, version, bucket),
          Buffer.concat(content),
          "EX",
          KEY_TTL_SECONDS,
        ),
      );
    }
    if (long.length > 0) {
      writes.push(
        this.redis.set(
          longKey(type, version),
          encodeLongEntries(long),
          "EX",
          KEY_TTL_SECONDS,
        ),
      );
    }
    await Promise.all(writes);

    // Atomic pointer swap: the new version becomes visible in one SET.
    await this.redis.set(
      pointerKey(type),
      JSON.stringify({ version, meta } satisfies ListPointer),
      "EX",
      KEY_TTL_SECONDS,
    );

    // Retire the superseded version with a grace window for in-flight reads.
    if (previous && previous.version !== version) {
      const expires: Promise<unknown>[] = [];
      for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
        expires.push(
          this.redis.expire(
            bucketKey(type, previous.version, bucket),
            OLD_VERSION_GRACE_SECONDS,
          ),
        );
      }
      expires.push(
        this.redis.expire(
          longKey(type, previous.version),
          OLD_VERSION_GRACE_SECONDS,
        ),
      );
      await Promise.all(expires);
    }

    return version;
  }

  /**
   * Checks a set of full expression hashes against every threat list.
   * Entirely local to our infrastructure: reads the synced buckets from
   * Redis and binary-searches them — nothing is sent to Google here.
   */
  async lookup(fullHashes: Buffer[]): Promise<WebRiskLookupResult> {
    const pointers = await this.getPointers();

    let oldestAgeSeconds = 0;
    for (const type of WEB_RISK_THREAT_TYPES) {
      const pointer = pointers.get(type);
      if (!pointer) return { status: "unavailable" };
      const age = (Date.now() - Date.parse(pointer.meta.syncedAt)) / 1000;
      if (!Number.isFinite(age)) return { status: "unavailable" };
      oldestAgeSeconds = Math.max(oldestAgeSeconds, age);
    }
    if (oldestAgeSeconds > config.THREAT_LIST_STALENESS_SECONDS) {
      return { status: "stale", ageSeconds: Math.round(oldestAgeSeconds) };
    }

    // Collect every bucket key we need across lists and hashes, fetch them
    // in one MGET, then binary-search locally.
    const keys: string[] = [];
    const keyIndex = new Map<string, number>();
    const keyFor = (key: string): number => {
      let index = keyIndex.get(key);
      if (index === undefined) {
        index = keys.length;
        keys.push(key);
        keyIndex.set(key, index);
      }
      return index;
    };

    interface Probe {
      type: WebRiskThreatType;
      fullHash: Buffer;
      bucketKeyIndex: number;
      longKeyIndex: number;
    }
    const probes: Probe[] = [];
    for (const type of WEB_RISK_THREAT_TYPES) {
      const pointer = pointers.get(type)!;
      const longIndex = keyFor(longKey(type, pointer.version));
      for (const fullHash of fullHashes) {
        probes.push({
          type,
          fullHash,
          bucketKeyIndex: keyFor(
            bucketKey(type, pointer.version, bucketIndex(fullHash)),
          ),
          longKeyIndex: longIndex,
        });
      }
    }

    const values = await this.redis.mgetBuffer(...keys);

    const hits: WebRiskPrefixHit[] = [];
    for (const probe of probes) {
      const bucket = values[probe.bucketKeyIndex];
      if (bucket && bucketContains(bucket, probe.fullHash.subarray(0, 4))) {
        hits.push({
          threatType: probe.type,
          prefix: probe.fullHash.subarray(0, 4),
          fullHash: probe.fullHash,
        });
        continue;
      }
      const longBlob = values[probe.longKeyIndex];
      if (longBlob) {
        for (const entry of decodeLongEntries(longBlob)) {
          if (
            entry.length <= probe.fullHash.length &&
            entry.equals(probe.fullHash.subarray(0, entry.length))
          ) {
            hits.push({
              threatType: probe.type,
              prefix: entry,
              fullHash: probe.fullHash,
            });
            break;
          }
        }
      }
    }

    return { status: "ok", hits };
  }
}

let defaultStore: WebRiskListStore | null = null;

/** Store singleton on the durable (non-evict) Redis connection. */
export function getWebRiskListStore(): WebRiskListStore {
  if (!defaultStore) {
    defaultStore = new WebRiskListStore(
      getRedisConnection() as unknown as WebRiskRedis,
    );
  }
  return defaultStore;
}
