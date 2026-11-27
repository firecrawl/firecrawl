import type { TupleItem } from "foundationdb";
import { z } from "zod";
import { config } from "../../../config";
import { safeParseLogged } from "../../../lib/zod-log";
import { getFdb } from "./client";

export { normalizeOwnerId } from "../../../lib/owner-id";

// All keys for a queue live under the tuple prefix ("nuq", queueName).
// Counters are 8-byte little-endian signed ints mutated with atomic ADD.

export const READY_SHARDS = config.NUQ_FDB_READY_SHARDS;
export const TEAM_PENDING_SHARDS = config.NUQ_FDB_TEAM_PENDING_SHARDS;
export const TIME_BUCKETS = config.NUQ_FDB_TIME_BUCKETS;

const nuqFdbJobStatusSchema = z.enum([
  "pending", // waiting for a concurrency slot (externally: "backlog")
  "queued", // holds its slots, in a ready shard
  "active",
  "completed",
  "failed",
  "cancelled",
]);

export type NuqFdbJobStatus = z.infer<typeof nuqFdbJobStatusSchema>;

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
const pendingLocSchema = z.discriminatedUnion("k", [
  z.object({ k: z.literal("tq"), s: z.number(), p: z.number(), c: z.number() }), // team-pending: shard, priority, createdAtMs
  z.object({ k: z.literal("kq"), p: z.number(), c: z.number() }), // key-pending: priority, createdAtMs
  z.object({ k: z.literal("gq"), p: z.number(), c: z.number() }), // crawl-pending: priority, createdAtMs
  z.object({ k: z.literal("dl"), at: z.number() }), // delay index: notBeforeMs
]);

export type PendingLoc = z.infer<typeof pendingLocSchema>;

function nullishToUndefined<T extends z.ZodType>(schema: T) {
  return schema
    .nullable()
    .transform(value => value ?? undefined)
    .optional();
}

export const jobMetaSchema = z.object({
  c: z.number(), // createdAt ms
  p: z.number(), // priority
  o: z.string(), // ownerId (normalized uuid)
  g: nullishToUndefined(z.string()), // groupId
  k: nullishToUndefined(z.string()), // API key id (set only when key-gated)
  f: z.number(), // flags
  to: nullishToUndefined(z.number()), // backlog timesOutAt ms
  dc: z.number(), // data chunk count
});

export type JobMeta = z.infer<typeof jobMetaSchema>;

export const jobStatusRecordSchema = z.object({
  s: nuqFdbJobStatusSchema,
  l: nullishToUndefined(z.string()), // lock uuid while active
  e: nullishToUndefined(z.number()), // lease expiry ms while active
  st: z.number(), // stall count
  fa: nullishToUndefined(z.number()), // finishedAt ms
  loc: nullishToUndefined(pendingLocSchema),
});

export type JobStatusRecord = z.infer<typeof jobStatusRecordSchema>;

// Entry stored in ready shards, pending queues and the delay index.
export const queueEntrySchema = z.object({
  i: z.string(), // jobId
  o: z.string(), // ownerId
  g: nullishToUndefined(z.string()), // groupId
  k: nullishToUndefined(z.string()), // API key id (set only when key-gated)
  p: z.number(), // priority
  f: z.number(), // flags
  c: z.number(), // createdAt ms
  to: nullishToUndefined(z.number()), // backlog timesOutAt ms
});

export type QueueEntry = z.infer<typeof queueEntrySchema>;

export function normalizeFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

const wireFiniteNumberSchema = z.preprocess(value => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }
  return normalizeFiniteNumber(value) ?? value;
}, z.number().finite().optional());

export const groupMetaSchema = z.object({
  o: z.string(), // ownerId
  c: z.number(), // createdAt ms
  t: z.number(), // ttl ms
  s: z.enum(["active", "completed", "cancelled"]),
  m: wireFiniteNumberSchema, // maxConcurrency
  d: wireFiniteNumberSchema, // delay seconds between job starts
  x: nullishToUndefined(z.number()), // expiresAt ms
});

export type GroupMeta = z.infer<typeof groupMetaSchema>;

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

export function encodeJson(v: unknown): Buffer {
  return Buffer.from(JSON.stringify(v), "utf8");
}

export function decodeJson<T>(
  buf: Buffer | undefined | null,
  schema: z.ZodType<T>,
  schemaTag: string | null,
): T | null {
  if (!buf) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
  const result =
    schemaTag !== null
      ? safeParseLogged(schema, parsed, schemaTag)
      : schema.safeParse(parsed);
  return result.success ? result.data : null;
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
