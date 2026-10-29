import { createHash, randomUUID } from "crypto";
import { config } from "../../../../config";
import { getRedisConnection } from "../../../../services/queue-service";
import { logger as _logger } from "../../../logger";
import {
  WEB_RISK_THREAT_TYPES,
  WebRiskListStore,
  getWebRiskListStore,
  type ThreatListMeta,
  type WebRiskRedis,
  type WebRiskThreatType,
} from "./store";

// Google Web Risk Update API sync worker (ZDR rework of "normal" mode).
//
// threatLists:computeDiff (free, unlike hashes:search) is polled per threat
// list: with no stored versionToken Google sends the full list (RESET),
// afterwards incremental additions/removals (DIFF). The updated list is
// checksum-verified and written to the versioned bucket store (./store.ts)
// with an atomic pointer swap.
//
// Topology: every API/worker process runs the loop, but a fleet-wide Redis
// lock ensures only one process actually syncs at a time. The loop respects
// Google's recommendedNextDiff (floored by
// THREAT_LIST_SYNC_MIN_INTERVAL_SECONDS). List age is logged every cycle so
// staleness is monitorable; a list older than THREAT_LIST_STALENESS_SECONDS
// is treated as unavailable by the check path (provider-failure semantics).

const logger = _logger.child({ module: "web-risk-sync" });

const LOCK_KEY = "threat_list_sync:lock";
const LOCK_TTL_SECONDS = 300;
const LOOP_TICK_MS = 30_000;
const SYNC_FETCH_TIMEOUT_MS = 120_000;

interface RawHashes {
  prefixSize?: number;
  rawHashes?: string;
}

interface ComputeDiffResponse {
  responseType?: "RESET" | "DIFF" | "RESPONSE_TYPE_UNSPECIFIED";
  additions?: { rawHashes?: RawHashes[] };
  removals?: { rawIndices?: { indices?: number[] } };
  newVersionToken?: string;
  checksum?: { sha256?: string };
  recommendedNextDiff?: string;
}

function isConfigured(): boolean {
  return (
    typeof config.GOOGLE_WEB_RISK_API_KEY === "string" &&
    config.GOOGLE_WEB_RISK_API_KEY.trim().length > 0
  );
}

async function computeDiff(
  type: WebRiskThreatType,
  versionToken: string | null,
): Promise<ComputeDiffResponse> {
  const params = new URLSearchParams();
  params.append("threatType", type);
  if (versionToken) params.append("versionToken", versionToken);
  params.append("constraints.supportedCompressions", "RAW");
  params.append("key", config.GOOGLE_WEB_RISK_API_KEY!);

  const response = await fetch(
    `${config.GOOGLE_WEB_RISK_API_URL}/v1/threatLists:computeDiff?${params.toString()}`,
    { method: "GET", signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS) },
  );
  if (!response.ok) {
    throw new Error(
      `Web Risk computeDiff for ${type} failed with status ${response.status}`,
    );
  }
  return (await response.json()) as ComputeDiffResponse;
}

function decodeAdditions(additions: RawHashes[] | undefined): Buffer[] {
  const entries: Buffer[] = [];
  for (const group of additions ?? []) {
    if (!group.rawHashes) continue;
    const prefixSize = group.prefixSize ?? 4;
    // The response is unvalidated remote JSON: a non-positive prefixSize
    // would make the offset loop below spin forever and stall the fleet-wide
    // sync for the whole lock TTL. Valid Web Risk prefixes are 4-32 bytes.
    if (!Number.isInteger(prefixSize) || prefixSize < 4 || prefixSize > 32) {
      throw new Error(
        `Web Risk computeDiff returned invalid prefixSize ${prefixSize}`,
      );
    }
    const blob = Buffer.from(group.rawHashes, "base64");
    for (
      let offset = 0;
      offset + prefixSize <= blob.length;
      offset += prefixSize
    ) {
      entries.push(blob.subarray(offset, offset + prefixSize));
    }
  }
  return entries;
}

/** Protocol checksum: sha256 over the sorted concatenated entries, base64. */
function listChecksum(sortedEntries: Buffer[]): string {
  const hash = createHash("sha256");
  for (const entry of sortedEntries) hash.update(entry);
  return hash.digest("base64");
}

function nextDiffAt(recommendedNextDiff: string | undefined): string {
  const floorMs =
    Date.now() + config.THREAT_LIST_SYNC_MIN_INTERVAL_SECONDS * 1000;
  const recommendedMs = recommendedNextDiff
    ? Date.parse(recommendedNextDiff)
    : NaN;
  return new Date(
    Number.isFinite(recommendedMs) ? Math.max(recommendedMs, floorMs) : floorMs,
  ).toISOString();
}

/**
 * Syncs a single list: computeDiff against the stored version, apply, verify
 * checksum, write + swap. On a checksum mismatch of an incremental diff the
 * list is re-synced from scratch once (RESET).
 */
async function syncList(
  store: WebRiskListStore,
  type: WebRiskThreatType,
  forceReset = false,
): Promise<void> {
  const pointer = forceReset ? null : await store.getPointer(type);
  const versionToken = pointer?.meta.versionToken ?? null;

  const diff = await computeDiff(type, versionToken);

  let entries: Buffer[];
  if (diff.responseType === "DIFF" && pointer) {
    entries = await store.loadEntries(type, pointer.version);
    const indices = diff.removals?.rawIndices?.indices ?? [];
    if (indices.length > 0) {
      const removed = new Set(indices);
      entries = entries.filter((_, index) => !removed.has(index));
    }
    entries = entries.concat(decodeAdditions(diff.additions?.rawHashes));
  } else {
    // RESET (or first sync): the additions are the entire list.
    entries = decodeAdditions(diff.additions?.rawHashes);
  }

  entries.sort(Buffer.compare);

  const expectedChecksum = diff.checksum?.sha256;
  if (expectedChecksum && listChecksum(entries) !== expectedChecksum) {
    if (diff.responseType === "DIFF") {
      logger.warn(
        "Web Risk list checksum mismatch after diff; re-syncing from scratch",
        { threatType: type },
      );
      return syncList(store, type, true);
    }
    throw new Error(`Web Risk ${type} full sync failed checksum verification`);
  }

  const meta: ThreatListMeta = {
    versionToken: diff.newVersionToken ?? versionToken ?? "",
    checksum: expectedChecksum ?? listChecksum(entries),
    count: entries.length,
    syncedAt: new Date().toISOString(),
    nextDiffAt: nextDiffAt(diff.recommendedNextDiff),
  };
  await store.writeVersion(type, entries, meta);

  logger.info("Web Risk threat list synced", {
    canonicalLog: "threat-protection/list-sync",
    threatType: type,
    responseType: diff.responseType ?? "RESET",
    entryCount: entries.length,
    nextDiffAt: meta.nextDiffAt,
  });
}

async function acquireLock(redis: WebRiskRedis): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(LOCK_KEY, token, "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK" ? token : null;
}

async function releaseLock(redis: WebRiskRedis, token: string): Promise<void> {
  // Get-compare-del (not atomic; worst case two syncers overlap briefly,
  // which the versioned store + atomic pointer swap makes harmless).
  const current = await redis.get(LOCK_KEY);
  if (current === token) await redis.del(LOCK_KEY);
}

function isListDue(
  pointer: Awaited<ReturnType<WebRiskListStore["getPointer"]>>,
  force: boolean,
): boolean {
  if (force || !pointer) return true;
  const next = Date.parse(pointer.meta.nextDiffAt);
  return !Number.isFinite(next) || next <= Date.now();
}

/**
 * Runs one sync pass under the fleet-wide lock: every due (or, with `force`,
 * every) list gets a computeDiff. Returns false when another process holds
 * the lock. Throws when Web Risk is not configured.
 */
export async function runThreatListSyncPass(
  options: { force?: boolean } = {},
  store: WebRiskListStore = getWebRiskListStore(),
  redis: WebRiskRedis = getRedisConnection() as unknown as WebRiskRedis,
): Promise<boolean> {
  if (!isConfigured()) {
    throw new Error("Google Web Risk is not configured");
  }

  const token = await acquireLock(redis);
  if (token === null) return false;

  try {
    for (const type of WEB_RISK_THREAT_TYPES) {
      const pointer = await store.getPointer(type);
      if (!isListDue(pointer, options.force ?? false)) continue;
      try {
        await syncList(store, type);
      } catch (error) {
        logger.error("Web Risk threat list sync failed", {
          canonicalLog: "threat-protection/list-sync",
          threatType: type,
          error,
        });
      }
    }
  } finally {
    await releaseLock(redis, token);
  }
  return true;
}

/** Logs the age of every stored list (staleness monitoring). */
async function logListAges(store: WebRiskListStore): Promise<void> {
  const pointers = await store.getPointers();
  const ages: Record<string, number | null> = {};
  let stale = false;
  for (const type of WEB_RISK_THREAT_TYPES) {
    const pointer = pointers.get(type);
    const ageSeconds = pointer
      ? Math.round((Date.now() - Date.parse(pointer.meta.syncedAt)) / 1000)
      : null;
    ages[type] = ageSeconds;
    if (
      ageSeconds === null ||
      ageSeconds > config.THREAT_LIST_STALENESS_SECONDS
    ) {
      stale = true;
    }
  }
  const log = stale ? logger.warn.bind(logger) : logger.info.bind(logger);
  log("Web Risk threat list age", {
    canonicalLog: "threat-protection/list-age",
    ageSeconds: ages,
    stale,
    stalenessThresholdSeconds: config.THREAT_LIST_STALENESS_SECONDS,
  });
}

let loopStarted = false;

/**
 * Starts the periodic sync loop for this process (idempotent, lazy — called
 * on first Web Risk provider use so every API/worker process that performs
 * checks also keeps the lists fresh). The Redis lock in
 * runThreatListSyncPass makes the fleet-wide behavior single-syncer.
 */
export function ensureThreatListSyncLoop(): void {
  if (loopStarted || !isConfigured()) return;
  loopStarted = true;

  let tick = 0;
  const timer = setInterval(() => {
    void (async () => {
      try {
        // Age metric every ~5min (stale lists log a warn from logListAges).
        if (tick++ % 10 === 0) {
          await logListAges(getWebRiskListStore());
        }
        await runThreatListSyncPass();
      } catch (error) {
        logger.warn("Web Risk sync loop tick failed", { error });
      }
    })();
  }, LOOP_TICK_MS);
  timer.unref();
}

let bootSyncPromise: Promise<void> | null = null;

/**
 * One forced sync pass per process lifetime, shared by all callers. Run
 * before the first lookup so that (a) a fresh deployment bootstraps the
 * lists and (b) a process never trusts a possibly-superseded stored state
 * without having compared version tokens with Google once. If another
 * process holds the sync lock, waits for it to finish instead.
 */
export function ensureThreatListBootSync(): Promise<void> {
  if (!bootSyncPromise) {
    bootSyncPromise = (async () => {
      const redis = getRedisConnection() as unknown as WebRiskRedis;
      const synced = await runThreatListSyncPass({ force: true });
      if (synced) return;
      // Another process is syncing right now — wait for the lock to clear,
      // bounded by the lock TTL (plus padding) so we cover the longest
      // possible sync: three sequential list fetches can exceed a minute.
      // Callers stay responsive regardless: the provider awaits this behind
      // the request's abort signal, and lists appearing mid-wait end it.
      const store = getWebRiskListStore();
      const deadline = Date.now() + LOCK_TTL_SECONDS * 1000 + 30_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if ((await redis.get(LOCK_KEY)) === null) return;
        // The other process swaps pointers list-by-list; once every list is
        // present we don't need to outwait its lock.
        const pointers = await store.getPointers();
        if ([...pointers.values()].every(pointer => pointer !== null)) return;
      }
    })().catch(error => {
      // Do not cache a failed boot sync: the next check retries it.
      bootSyncPromise = null;
      throw error;
    });
  }
  return bootSyncPromise;
}
