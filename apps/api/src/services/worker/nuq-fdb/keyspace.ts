import type { TupleItem } from "foundationdb";
import { config } from "../../../config";
import { isJsonObject } from "../../../lib/json-types";
import { getFdb } from "./client";

export { normalizeOwnerId } from "../../../lib/owner-id";

// All keys for a queue live under the tuple prefix ("nuq", queueName).
// Counters are 8-byte little-endian signed ints mutated with atomic ADD.

export const READY_SHARDS = config.NUQ_FDB_READY_SHARDS;
export const TEAM_PENDING_SHARDS = config.NUQ_FDB_TEAM_PENDING_SHARDS;
export const TIME_BUCKETS = config.NUQ_FDB_TIME_BUCKETS;

export type NuqFdbJobStatus =
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
  x?: number; // expiresAt ms
};

export function encodeI64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(n));
  return buf;
}

export function decodeI64(buf: Buffer | undefined | null): number {
  if (!buf || buf.length < 8) {
    return 0;
  }
  return Number(buf.readBigInt64LE());
}

type ExternalSlotRecordShape = {
  e: number;
};

type ExternalSlotExpiryRef = {
  t: string;
};

function isNuqFdbJobStatus(value: unknown): value is NuqFdbJobStatus {
  return (
    value === "pending" ||
    value === "queued" ||
    value === "active" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isPendingLoc(value: unknown): value is PendingLoc {
  if (!isJsonObject(value)) {
    return false;
  }
  if (value.k === "tq") {
    return (
      typeof value.s === "number" &&
      typeof value.p === "number" &&
      typeof value.c === "number"
    );
  }
  if (value.k === "kq" || value.k === "gq") {
    return typeof value.p === "number" && typeof value.c === "number";
  }
  if (value.k === "dl") {
    return typeof value.at === "number";
  }
  return false;
}

export function isJobMeta(value: unknown): value is JobMeta {
  return (
    isJsonObject(value) &&
    typeof value.c === "number" &&
    typeof value.p === "number" &&
    typeof value.o === "string" &&
    (value.g === undefined || typeof value.g === "string") &&
    (value.k === undefined || typeof value.k === "string") &&
    typeof value.f === "number" &&
    (value.to === undefined || typeof value.to === "number") &&
    typeof value.dc === "number"
  );
}

export function isJobStatusRecord(value: unknown): value is JobStatusRecord {
  return (
    isJsonObject(value) &&
    isNuqFdbJobStatus(value.s) &&
    (value.l === undefined || typeof value.l === "string") &&
    (value.e === undefined || typeof value.e === "number") &&
    typeof value.st === "number" &&
    (value.fa === undefined || typeof value.fa === "number") &&
    (value.loc === undefined || isPendingLoc(value.loc))
  );
}

export function isQueueEntry(value: unknown): value is QueueEntry {
  return (
    isJsonObject(value) &&
    typeof value.i === "string" &&
    typeof value.o === "string" &&
    (value.g === undefined || typeof value.g === "string") &&
    (value.k === undefined || typeof value.k === "string") &&
    typeof value.p === "number" &&
    typeof value.f === "number" &&
    typeof value.c === "number" &&
    (value.to === undefined || typeof value.to === "number")
  );
}

export function isGroupMeta(value: unknown): value is GroupMeta {
  return (
    isJsonObject(value) &&
    typeof value.o === "string" &&
    typeof value.c === "number" &&
    typeof value.t === "number" &&
    (value.s === "active" ||
      value.s === "completed" ||
      value.s === "cancelled") &&
    (value.m === undefined || typeof value.m === "number") &&
    (value.d === undefined || typeof value.d === "number") &&
    (value.x === undefined || typeof value.x === "number")
  );
}

function isExternalSlotRecordShape(
  value: unknown,
): value is ExternalSlotRecordShape {
  return isJsonObject(value) && typeof value.e === "number";
}

function isExternalSlotExpiryRef(
  value: unknown,
): value is ExternalSlotExpiryRef {
  return isJsonObject(value) && typeof value.t === "string";
}

export function encodeJson(v: unknown): Buffer {
  return Buffer.from(JSON.stringify(v), "utf8");
}

export function decodeJson<T>(
  buf: Buffer | undefined | null,
  guard: (value: unknown) => value is T,
): T | null;
export function decodeJson<_T extends GroupMeta>(
  buf: Buffer | undefined | null,
): GroupMeta | null;
export function decodeJson<_T extends ExternalSlotRecordShape>(
  buf: Buffer | undefined | null,
): ExternalSlotRecordShape | null;
export function decodeJson<_T extends ExternalSlotExpiryRef>(
  buf: Buffer | undefined | null,
): ExternalSlotExpiryRef | null;
export function decodeJson<T>(
  buf: Buffer | undefined | null,
  guard?: (value: unknown) => value is T,
): T | GroupMeta | ExternalSlotRecordShape | ExternalSlotExpiryRef | null {
  if (!buf) {
    return null;
  }
  const parsed: unknown = JSON.parse(buf.toString("utf8"));
  if (guard) {
    return guard(parsed) ? parsed : null;
  }
  if (isGroupMeta(parsed)) {
    return parsed;
  }
  if (isExternalSlotRecordShape(parsed)) {
    return parsed;
  }
  if (isExternalSlotExpiryRef(parsed)) {
    return parsed;
  }
  return null;
}

export function fnv1a(str: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93);
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

  pack(parts: Array<TupleItem>): Buffer {
    return getFdb().tuple.pack(["nuq", this.queueName, ...parts]);
  }

  private packRange(parts: Array<TupleItem>) {
    const begin = this.pack(parts);
    return { begin, end: prefixEnd(begin) };
  }

  unpack(key: Buffer): Array<unknown> {
    return getFdb().tuple.unpack(key);
  }

  // === Job records
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
  teamPendingCount(tid: string): Buffer {
    return this.pack(["t", tid, "pend"]);
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
  groupRemaining(gid: string): Buffer {
    return this.pack(["g", gid, "rem"]);
  }
  groupCrawlActive(gid: string): Buffer {
    return this.pack(["g", gid, "cact"]);
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
  groupRange(gid: string) {
    return this.packRange(["g", gid]);
  }
  ongoingGroup(ownerId: string, gid: string): Buffer {
    return this.pack(["go", ownerId, gid]);
  }
  ongoingGroupRange(ownerId: string) {
    return this.packRange(["go", ownerId]);
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
  groupExpiry(atMs: number, gid: string): Buffer {
    return this.pack(["gexp", atMs, gid]);
  }
  groupExpiryScanRange(untilMs: number) {
    return {
      begin: this.pack(["gexp"]),
      end: this.pack(["gexp", untilMs]),
    };
  }

  // === Task keys (blind-set, sweeper-drained)
  taskGroupFinish(gid: string): Buffer {
    return this.pack(["task", "gfin", gid]);
  }
  taskGroupFinishRange() {
    return this.packRange(["task", "gfin"]);
  }
  taskGroupCancel(gid: string): Buffer {
    return this.pack(["task", "gcancel", gid]);
  }
  taskGroupCancelRange() {
    return this.packRange(["task", "gcancel"]);
  }
  taskTeamRaise(tid: string): Buffer {
    return this.pack(["task", "traise", tid]);
  }
  taskTeamRaiseRange() {
    return this.packRange(["task", "traise"]);
  }
  taskKeyRaise(kid: string): Buffer {
    return this.pack(["task", "kraise", kid]);
  }
  taskKeyRaiseRange() {
    return this.packRange(["task", "kraise"]);
  }
  sweeperLock(): Buffer {
    return this.pack(["sweep", "lock"]);
  }

  unpackId(key: Buffer, indexFromEnd: number = 0): string {
    const parts = getFdb().tuple.unpack(key);
    return String(parts[parts.length - 1 - indexFromEnd]);
  }
}
