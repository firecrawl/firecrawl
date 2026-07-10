import { config } from "../../../config";
import { getFdb } from "./client";

export { normalizeOwnerId } from "../../../lib/owner-id";

// All keys for a queue live under the tuple prefix ("nuq", queueName).
// Counters are 8-byte little-endian signed ints mutated with atomic ADD.

export const READY_SHARDS = config.NUQ_FDB_READY_SHARDS;
export const TEAM_PENDING_SHARDS = config.NUQ_FDB_TEAM_PENDING_SHARDS;
export const TIME_BUCKETS = config.NUQ_FDB_TIME_BUCKETS;
export const METRIC_SHARDS = 32;
export const METRIC_STATUSES = [
  "pending",
  "queued",
  "active",
  "completed",
  "failed",
] as const;
export type NuqFdbMetricStatus = (typeof METRIC_STATUSES)[number];
export type NuqFdbMetricPhase = "backfill-jobs" | "backfill-ledger" | "ready";
export type NuqFdbMetricControl = {
  format: 3;
  generation: string;
  phase: NuqFdbMetricPhase;
  shards: 32;
};

export type NuqFdbJobStatus =
  | "ingesting" // reserved by a resumable multi-transaction enqueue
  | "pending" // waiting for a concurrency slot (externally: "backlog")
  | "queued" // holds its slots, in a ready shard
  | "active"
  | "completed"
  | "failed"
  | "cancelled";

// Job flags (bitmask on job meta and queue entries)
export const F_GATED = 1; // holds a team slot while queued/active
export const F_CRAWL_GATED = 2; // holds a crawl slot while team-pending/queued/active
export const F_LISTENABLE = 4;
export const F_ZDR = 8;
export const F_COUNTABLE = 16; // mode === "single_urls": counted in group numeric stats
export const F_GACC = 32; // participates in group remaining-count accounting
export const F_KEY_GATED = 64; // holds an API-key slot while team-pending/queued/active

// Where a pending job's queue entry lives, stored on its status record so
// sweepers and removers can clear the exact key without scanning.
export type PendingLoc =
  | { k: "tq"; s: number; p: number; c: number } // team-pending: shard, priority, createdAtMs
  | { k: "kq"; p: number; c: number } // key-pending: priority, createdAtMs
  | { k: "gq"; p: number; c: number } // crawl-pending: priority, createdAtMs
  | { k: "dl"; at: number }; // delay index: notBeforeMs

export type JobMeta = {
  c: number; // createdAt ms
  p: number; // priority
  o: string; // ownerId (normalized uuid)
  g?: string; // groupId
  k?: string; // API key id (set only when key-gated)
  f: number; // flags
  to?: number; // backlog timesOutAt ms
  dc: number; // data chunk count
};

export type JobStatusRecord = {
  s: NuqFdbJobStatus;
  l?: string; // lock uuid while active
  e?: number; // lease expiry ms while active
  st: number; // stall count
  fa?: number; // finishedAt ms
  loc?: PendingLoc;
  op?: string; // ingest operation while s === "ingesting"
};

export type IngestMeta = {
  o: string; // normalized owner id (or empty for ungated/self-hosted)
  c: number; // creation time
  x: number; // abandoned-ingest cleanup time
  r: number; // team queue-cap reservations not yet published
  l: number | null; // frozen team limit
  q: number; // frozen team queue cap
  k?: { id: string; limit: number } | null; // frozen API-key gate
};

export type ClaimRecord = {
  i: string;
  l: string;
  e: number;
};

// Entry stored in ready shards, pending queues and the delay index.
export type QueueEntry = {
  i: string; // jobId
  o: string; // ownerId
  g?: string; // groupId
  k?: string; // API key id (set only when key-gated)
  p: number; // priority
  f: number; // flags
  c: number; // createdAt ms
  to?: number; // backlog timesOutAt ms
};

export type GroupMeta = {
  o: string; // ownerId
  c: number; // createdAt ms
  t: number; // ttl ms
  s: "active" | "completed" | "cancelled";
  m?: number; // maxConcurrency
  d?: number; // delay seconds between job starts
  x?: number; // completed-group expiresAt ms
  a?: number; // active-group abandonment deadline ms
  eg?: string; // generation of the currently scheduled expiry
  z?: boolean; // abandonment deadline elapsed; force-drain nonterminal work
};

export type RaiseTask = {
  g: string; // generation; protects a newer task from an older sweeper
};

export function encodeI64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(n));
  return buf;
}

export function decodeI64(buf: Buffer | undefined | null): number {
  if (!buf || buf.length < 8) return 0;
  return Number(buf.readBigInt64LE());
}

export function encodeJson(v: any): Buffer {
  return Buffer.from(JSON.stringify(v), "utf8");
}

export function decodeJson<T = any>(buf: Buffer | undefined | null): T | null {
  if (!buf) return null;
  return JSON.parse(buf.toString("utf8")) as T;
}

export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function prefixEnd(prefix: Buffer): Buffer {
  const end = Buffer.from(prefix);
  for (let i = end.length - 1; i >= 0; i--) {
    if (end[i] !== 0xff) {
      end[i]++;
      return end.subarray(0, i + 1);
    }
  }
  throw new Error("Unable to construct FDB prefix range end");
}

export function timeBucket(jobId: string): number {
  return fnv1a(jobId) % TIME_BUCKETS;
}

export function teamPendingShard(jobId: string): number {
  // different rotation than timeBucket so the two don't correlate
  return fnv1a(jobId + "/tq") % TEAM_PENDING_SHARDS;
}

export class NuqFdbKeyspace {
  constructor(public readonly queueName: string) {}

  pack(parts: any[]): Buffer {
    return getFdb().tuple.pack(["nuq", this.queueName, ...parts]) as Buffer;
  }

  private packRange(parts: any[]): { begin: Buffer; end: Buffer } {
    const begin = this.pack(parts);
    return { begin, end: prefixEnd(begin) };
  }

  unpack(key: Buffer): unknown[] {
    return getFdb().tuple.unpack(key);
  }

  // === Job records
  jobRootRange() {
    return this.packRange(["j"]);
  }
  jobMeta(id: string): Buffer {
    return this.pack(["j", id, "m"]);
  }
  jobStatus(id: string): Buffer {
    return this.pack(["j", id, "s"]);
  }
  jobData(id: string, chunk: number): Buffer {
    return this.pack(["j", id, "d", chunk]);
  }
  jobDataRange(id: string) {
    return this.packRange(["j", id, "d"]);
  }
  jobReturnvalue(id: string, chunk: number): Buffer {
    return this.pack(["j", id, "r", chunk]);
  }
  jobReturnvalueRange(id: string) {
    return this.packRange(["j", id, "r"]);
  }
  jobFailedReason(id: string): Buffer {
    return this.pack(["j", id, "f"]);
  }
  jobRange(id: string) {
    return this.packRange(["j", id]);
  }

  // === Resumable enqueue / commit-unknown claim records
  ingest(op: string): Buffer {
    return this.pack(["ing", op, "meta"]);
  }
  ingestJob(op: string, id: string): Buffer {
    return this.pack(["ing", op, "jobs", id]);
  }
  ingestJobRange(op: string) {
    return this.packRange(["ing", op, "jobs"]);
  }
  ingestGroup(op: string, gid: string): Buffer {
    return this.pack(["ing", op, "groups", gid]);
  }
  ingestGroupRange(op: string) {
    return this.packRange(["ing", op, "groups"]);
  }
  ingestExpiry(atMs: number, op: string): Buffer {
    return this.pack(["ingexp", atMs, op]);
  }
  ingestExpiryScanRange(untilMs: number) {
    return {
      begin: this.pack(["ingexp"]),
      end: this.pack(["ingexp", untilMs]),
    };
  }
  claim(op: string): Buffer {
    return this.pack(["claim", op]);
  }
  claimRange() {
    return this.packRange(["claim"]);
  }
  claimExpiry(atMs: number, op: string): Buffer {
    return this.pack(["claimexp", atMs, op]);
  }
  claimExpiryRange() {
    return this.packRange(["claimexp"]);
  }
  claimExpiryScanRange(untilMs: number) {
    return {
      begin: this.pack(["claimexp"]),
      end: this.pack(["claimexp", untilMs]),
    };
  }

  // === Team gate
  teamLimit(tid: string): Buffer {
    return this.pack(["t", tid, "limit"]);
  }
  teamRange() {
    return this.packRange(["t"]);
  }
  teamActive(tid: string): Buffer {
    return this.pack(["t", tid, "active"]);
  }
  teamActiveIndex(tid: string): Buffer {
    return this.pack(["ta", tid]);
  }
  teamActiveIndexRange() {
    return this.packRange(["ta"]);
  }
  teamLedgerGcIndex(tid: string): Buffer {
    return this.pack(["tgc", timeBucket(tid), tid]);
  }
  teamLedgerGcIndexRange(bucket: number) {
    return this.packRange(["tgc", bucket]);
  }
  teamPendingCount(tid: string): Buffer {
    return this.pack(["t", tid, "pend"]);
  }
  teamIngestReserved(tid: string): Buffer {
    return this.pack(["t", tid, "ing"]);
  }
  teamShardCount(tid: string, shard: number): Buffer {
    return this.pack(["t", tid, "qn", shard]);
  }
  teamShardCountRange(tid: string) {
    return this.packRange(["t", tid, "qn"]);
  }
  teamPendingKey(
    tid: string,
    shard: number,
    priority: number,
    createdAtMs: number,
    id: string,
  ): Buffer {
    return this.pack(["t", tid, "q", shard, priority, createdAtMs, id]);
  }
  teamPendingShardRange(tid: string, shard: number) {
    return this.packRange(["t", tid, "q", shard]);
  }

  // === API-key gate (sits between the crawl gate and the team gate)
  keyLimit(kid: string): Buffer {
    return this.pack(["k", kid, "limit"]);
  }
  keyActive(kid: string): Buffer {
    return this.pack(["k", kid, "active"]);
  }
  keyLedgerIndex(kid: string): Buffer {
    return this.pack(["ki2", timeBucket(kid), kid]);
  }
  keyLedgerIndexRange(bucket: number) {
    return this.packRange(["ki2", bucket]);
  }
  keyGateRange() {
    return this.packRange(["k"]);
  }
  keyPendingCount(kid: string): Buffer {
    return this.pack(["k", kid, "qn"]);
  }
  keyPendingKey(
    kid: string,
    priority: number,
    createdAtMs: number,
    id: string,
  ): Buffer {
    return this.pack(["k", kid, "q", priority, createdAtMs, id]);
  }
  keyPendingRange(kid: string) {
    return this.packRange(["k", kid, "q"]);
  }

  // === Group (crawl) records
  groupMeta(gid: string): Buffer {
    return this.pack(["g", gid, "meta"]);
  }
  groupAllRange() {
    return this.packRange(["g"]);
  }
  groupRemaining(gid: string): Buffer {
    return this.pack(["g", gid, "rem"]);
  }
  groupCrawlActive(gid: string): Buffer {
    return this.pack(["g", gid, "cact"]);
  }
  groupIngestCount(gid: string): Buffer {
    return this.pack(["g", gid, "ing"]);
  }
  groupStatusCount(gid: string, status: string): Buffer {
    return this.pack(["g", gid, "n", status]);
  }
  groupStatusCountRange(gid: string) {
    return this.packRange(["g", gid, "n"]);
  }
  groupPendingCount(gid: string): Buffer {
    return this.pack(["g", gid, "qn"]);
  }
  groupPendingKey(
    gid: string,
    priority: number,
    createdAtMs: number,
    id: string,
  ): Buffer {
    return this.pack(["g", gid, "q", priority, createdAtMs, id]);
  }
  groupPendingRange(gid: string) {
    return this.packRange(["g", gid, "q"]);
  }
  groupJob(gid: string, id: string): Buffer {
    return this.pack(["g", gid, "jobs", id]);
  }
  groupJobRange(gid: string) {
    return this.packRange(["g", gid, "jobs"]);
  }
  groupDonePrefix(gid: string): Buffer {
    return this.pack(["g", gid, "done"]);
  }
  groupDoneRange(gid: string) {
    return this.packRange(["g", gid, "done"]);
  }
  groupFinishedJob(gid: string): Buffer {
    return this.pack(["g", gid, "fjob"]);
  }
  groupCancelCursor(gid: string): Buffer {
    return this.pack(["g", gid, "ccur"]);
  }
  groupGcCursor(gid: string): Buffer {
    return this.pack(["g", gid, "gccur"]);
  }
  groupRange(gid: string) {
    return this.packRange(["g", gid]);
  }
  ongoingGroup(ownerId: string, gid: string): Buffer {
    return this.pack(["go", ownerId, gid]);
  }
  ongoingGroupRange(ownerId: string) {
    return this.packRange(["go", ownerId]);
  }
  ongoingGroupAllRange() {
    return this.packRange(["go"]);
  }

  // === Ready shards
  readyPrefix(shard: number, priority: number): Buffer {
    return this.pack(["r", shard, "q", priority]);
  }
  readyShardRange(shard: number) {
    return this.packRange(["r", shard, "q"]);
  }
  readyShardCount(shard: number): Buffer {
    return this.pack(["rn", shard]);
  }
  readyShardCountRange() {
    return this.packRange(["rn"]);
  }

  // === Generation-scoped maintained queue metrics
  // Writers always normal-read the stable control key, including while it is
  // absent. Generation data is immutable after invalidation and therefore can
  // never leak into a later activation.
  metricControl(): Buffer {
    return this.pack(["metrics", "v3", "ctl"]);
  }
  metricCount(
    generation: string,
    status: NuqFdbMetricStatus,
    shard: number,
  ): Buffer {
    return this.pack(["metrics", "v3", "gen", generation, "n", status, shard]);
  }
  metricLedger(generation: string, id: string): Buffer {
    return this.pack(["metrics", "v3", "gen", generation, "status", id]);
  }
  metricLedgerRange(generation: string) {
    return this.packRange(["metrics", "v3", "gen", generation, "status"]);
  }
  metricJobsCursor(generation: string): Buffer {
    return this.pack(["metrics", "v3", "gen", generation, "cursor", "jobs"]);
  }
  metricLedgerCursor(generation: string): Buffer {
    return this.pack(["metrics", "v3", "gen", generation, "cursor", "ledger"]);
  }

  // === Time-ordered indexes (sweeper-owned)
  lease(bucket: number, expMs: number, id: string): Buffer {
    return this.pack(["lease", bucket, expMs, id]);
  }
  leaseRange() {
    return this.packRange(["lease"]);
  }
  leaseScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.pack(["lease", bucket]),
      end: this.pack(["lease", bucket, untilMs]),
    };
  }
  backlogTimeout(bucket: number, atMs: number, id: string): Buffer {
    return this.pack(["bto", bucket, atMs, id]);
  }
  backlogTimeoutScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.pack(["bto", bucket]),
      end: this.pack(["bto", bucket, untilMs]),
    };
  }
  delayed(bucket: number, notBeforeMs: number, id: string): Buffer {
    return this.pack(["delay", bucket, notBeforeMs, id]);
  }
  delayedScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.pack(["delay", bucket]),
      end: this.pack(["delay", bucket, untilMs]),
    };
  }
  jobExpiry(bucket: number, atMs: number, id: string): Buffer {
    return this.pack(["jexp", bucket, atMs, id]);
  }
  jobExpiryScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.pack(["jexp", bucket]),
      end: this.pack(["jexp", bucket, untilMs]),
    };
  }
  groupExpiry(atMs: number, gid: string, generation: string = ""): Buffer {
    return this.pack(["gexp2", timeBucket(gid), atMs, gid, generation]);
  }
  groupExpiryScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.pack(["gexp2", bucket]),
      end: this.pack(["gexp2", bucket, untilMs]),
    };
  }
  legacyGroupExpiryScanRange(untilMs: number) {
    return {
      begin: this.pack(["gexp"]),
      end: this.pack(["gexp", untilMs]),
    };
  }

  // === Task keys (blind-set, sweeper-drained)
  // New tasks are hash-partitioned. The legacy ranges remain readable during
  // rolling deployment so work written by an older replica is not lost.
  taskGroupFinish(gid: string): Buffer {
    return this.pack(["task2", "gfin", timeBucket(gid), gid]);
  }
  taskGroupFinishRange(bucket: number) {
    return this.packRange(["task2", "gfin", bucket]);
  }
  legacyTaskGroupFinishRange() {
    return this.packRange(["task", "gfin"]);
  }
  taskGroupCancel(gid: string): Buffer {
    return this.pack(["task2", "gcancel", timeBucket(gid), gid]);
  }
  taskGroupCancelRange(bucket: number) {
    return this.packRange(["task2", "gcancel", bucket]);
  }
  legacyTaskGroupCancelRange() {
    return this.packRange(["task", "gcancel"]);
  }
  taskTeamRaise(tid: string): Buffer {
    return this.pack(["task2", "traise", timeBucket(tid), tid]);
  }
  taskTeamRaiseRange(bucket: number) {
    return this.packRange(["task2", "traise", bucket]);
  }
  legacyTaskTeamRaiseRange() {
    return this.packRange(["task", "traise"]);
  }
  taskKeyRaise(kid: string): Buffer {
    return this.pack(["task2", "kraise", timeBucket(kid), kid]);
  }
  taskKeyRaiseRange(bucket: number) {
    return this.packRange(["task2", "kraise", bucket]);
  }
  legacyTaskKeyRaiseRange() {
    return this.packRange(["task", "kraise"]);
  }
  legacySweeperLock(): Buffer {
    return this.pack(["sweep", "lock"]);
  }
  sweeperPartition(phase: string, partition: number): Buffer {
    return this.pack(["sweep", phase, partition, "lock"]);
  }
  sweeperCursor(phase: string, partition: number): Buffer {
    return this.pack(["sweep", phase, partition, "cursor"]);
  }

  unpackId(key: Buffer, indexFromEnd: number = 0): string {
    const parts = getFdb().tuple.unpack(key);
    return String(parts[parts.length - 1 - indexFromEnd]);
  }
}
