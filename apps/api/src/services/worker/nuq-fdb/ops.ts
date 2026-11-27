import type { Transaction } from "foundationdb";
import { z } from "zod";
import { logger as _logger } from "../../../lib/logger";
import type {
  NuqFdbKeyspace,
  QueueEntry,
  JobStatusRecord,
  PendingLoc,
} from "./keyspace";
import {
  encodeI64,
  decodeI64,
  encodeJson,
  decodeJson,
  groupMetaSchema,
  jobMetaSchema,
  jobStatusRecordSchema,
  queueEntrySchema,
  timeBucket,
  teamPendingShard,
  READY_SHARDS,
  F_GATED,
  F_CRAWL_GATED,
  F_COUNTABLE,
  F_GACC,
  F_KEY_GATED,
  F_ZDR,
} from "./keyspace";

export const ONE = encodeI64(1);
export const MINUS_ONE = encodeI64(-1);
export const EMPTY = Buffer.alloc(0);

export const LEASE_MS = 90_000;
export const MAX_STALLS = 9;
export const COMPLETED_STANDALONE_RETENTION_MS = 60 * 60 * 1000;
export const FAILED_STANDALONE_RETENTION_MS = 6 * 60 * 60 * 1000;

export function bumpTeamActive(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  teamId: string,
  delta: number,
): void {
  if (delta === 0) {
    return;
  }
  const encoded = encodeI64(delta);
  tn.add(ks.teamActive(teamId), encoded);
  tn.add(ks.teamActiveIndex(teamId), encoded);
}

// Per-transaction-attempt context. uv makes versionstamp-suffixed keys unique
// within one transaction; it resets naturally when doTn retries the closure.
export type TxContext = { uv: number };

export function newTxContext(): TxContext {
  return { uv: 0 };
}

export function uvSuffix(txc: TxContext): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(txc.uv++);
  return buf;
}

export function randomReadyShard(): number {
  return Math.floor(Math.random() * READY_SHARDS);
}

// === Status record writers

export function setStatusQueued(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  id: string,
  stalls: number = 0,
): void {
  const rec: JobStatusRecord = { s: "queued", st: stalls };
  tn.set(ks.jobStatus(id), encodeJson(rec));
}

export function setStatusPending(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  id: string,
  loc: PendingLoc,
): void {
  const rec: JobStatusRecord = { s: "pending", st: 0, loc };
  tn.set(ks.jobStatus(id), encodeJson(rec));
}

// === Queue placement

export function pushReady(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  e: QueueEntry,
  txc: TxContext,
): void {
  const shard = randomReadyShard();
  tn.setVersionstampSuffixedKey(
    ks.readyPrefix(shard, e.p),
    encodeJson(e),
    uvSuffix(txc),
  );
  tn.add(ks.readyShardCount(shard), ONE);
}

export function appendTeamPending(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  e: QueueEntry,
): PendingLoc {
  const shard = teamPendingShard(e.i);
  tn.set(ks.teamPendingKey(e.o, shard, e.p, e.c, e.i), encodeJson(e));
  tn.add(ks.teamShardCount(e.o, shard), ONE);
  tn.add(ks.teamPendingCount(e.o), ONE);
  if (e.to !== undefined) {
    tn.set(ks.backlogTimeout(timeBucket(e.i), e.to, e.i), EMPTY);
  }
  return { k: "tq", s: shard, p: e.p, c: e.c };
}

export function appendKeyPending(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  e: QueueEntry,
): PendingLoc {
  const keyId = e.k;
  if (!keyId) {
    throw new Error("Key-gated queue entry is missing API key id");
  }
  tn.set(ks.keyPendingKey(keyId, e.p, e.c, e.i), encodeJson(e));
  tn.add(ks.keyPendingCount(keyId), ONE);
  tn.add(ks.teamPendingCount(e.o), ONE);
  if (e.to !== undefined) {
    tn.set(ks.backlogTimeout(timeBucket(e.i), e.to, e.i), EMPTY);
  }
  return { k: "kq", p: e.p, c: e.c };
}

export function appendCrawlPending(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  e: QueueEntry,
): PendingLoc {
  const groupId = e.g;
  if (!groupId) {
    throw new Error("Crawl-gated queue entry is missing group id");
  }
  tn.set(ks.groupPendingKey(groupId, e.p, e.c, e.i), encodeJson(e));
  tn.add(ks.groupPendingCount(groupId), ONE);
  tn.add(ks.teamPendingCount(e.o), ONE);
  if (e.to !== undefined) {
    tn.set(ks.backlogTimeout(timeBucket(e.i), e.to, e.i), EMPTY);
  }
  return { k: "gq", p: e.p, c: e.c };
}

export function clearBacklogTimeout(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  e: { i: string; to?: number },
): void {
  if (e.to !== undefined) {
    tn.clear(ks.backlogTimeout(timeBucket(e.i), e.to, e.i));
  }
}

// Moves a pending entry into a ready shard, with group counter upkeep.
// Callers are responsible for slot accounting.
export function promoteEntryToReady(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  e: QueueEntry,
  txc: TxContext,
): void {
  pushReady(tn, ks, e, txc);
  setStatusQueued(tn, ks, e.i);
  if (e.g && e.f & F_COUNTABLE) {
    tn.add(ks.groupStatusCount(e.g, "pending"), MINUS_ONE);
    tn.add(ks.groupStatusCount(e.g, "queued"), ONE);
  }
}

// Reconstructs the exact pending key for a job from its status record.
export function pendingKeyFromLoc(
  ks: NuqFdbKeyspace,
  id: string,
  ownerId: string,
  groupId: string | undefined,
  keyId: string | undefined,
  loc: PendingLoc,
): Buffer {
  if (loc.k === "tq") {
    return ks.teamPendingKey(ownerId, loc.s, loc.p, loc.c, id);
  }
  if (loc.k === "kq") {
    if (!keyId) {
      throw new Error("Key-pending placement is missing API key id");
    }
    return ks.keyPendingKey(keyId, loc.p, loc.c, id);
  }
  if (loc.k === "gq") {
    if (!groupId) {
      throw new Error("Group-pending placement is missing group id");
    }
    return ks.groupPendingKey(groupId, loc.p, loc.c, id);
  }
  return ks.delayed(timeBucket(id), loc.at, id);
}

// Clears a pending job's queue entry + counters + backlog timeout. The caller
// is responsible for slot accounting and the job's status/records.
export function clearPendingPlacement(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  id: string,
  ownerId: string,
  groupId: string | undefined,
  keyId: string | undefined,
  loc: PendingLoc,
  timesOutAt: number | undefined,
): void {
  tn.clear(pendingKeyFromLoc(ks, id, ownerId, groupId, keyId, loc));
  if (loc.k === "tq") {
    tn.add(ks.teamShardCount(ownerId, loc.s), MINUS_ONE);
    tn.add(ks.teamPendingCount(ownerId), MINUS_ONE);
  } else if (loc.k === "kq") {
    if (!keyId) {
      throw new Error("Key-pending placement is missing API key id");
    }
    tn.add(ks.keyPendingCount(keyId), MINUS_ONE);
    tn.add(ks.teamPendingCount(ownerId), MINUS_ONE);
  } else if (loc.k === "gq") {
    if (!groupId) {
      throw new Error("Group-pending placement is missing group id");
    }
    tn.add(ks.groupPendingCount(groupId), MINUS_ONE);
    tn.add(ks.teamPendingCount(ownerId), MINUS_ONE);
  }
  if (loc.k !== "dl") {
    clearBacklogTimeout(tn, ks, { i: id, to: timesOutAt });
  }
}

// === Pending queue pops

// Pops the best entry from a team's pending shards. Snapshot-reads the shard
// occupancy counters and probes up to 3 non-empty shards. Returns null if all
// probed shards are empty.
const MAX_CORRUPT_PENDING_SKIPS = 16;

export async function popTeamPending(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  tid: string,
  txc: TxContext,
): Promise<QueueEntry | null> {
  const startedAt = Date.now();
  const range = ks.teamShardCountRange(tid);
  const counts = await tn.snapshot().getRangeAll(range.begin, range.end);
  const nonEmpty: Array<number> = [];
  for (const [key, value] of counts) {
    if (decodeI64(value) > 0) {
      nonEmpty.push(Number(ks.unpackId(key)));
    }
  }
  // shuffle so concurrent finishers spread across shards
  for (let i = nonEmpty.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nonEmpty[i], nonEmpty[j]] = [nonEmpty[j], nonEmpty[i]];
  }
  let probedShards = 0;
  let staleShardCounters = 0;
  for (const shard of nonEmpty.slice(0, 3)) {
    probedShards++;
    const r = ks.teamPendingShardRange(tid, shard);
    const head = await tn.getRangeAll(r.begin, r.end, { limit: 1 });
    if (head.length === 0) {
      staleShardCounters++;
      continue; // counter was stale
    }
    const [key, value] = head[0];
    const e = decodeJson(value, queueEntrySchema, "nuq-fdb.queueEntry");
    tn.clear(key);
    tn.add(ks.teamShardCount(tid, shard), MINUS_ONE);
    tn.add(ks.teamPendingCount(tid), MINUS_ONE);
    if (!e) {
      await failCorruptPendingEntry(tn, ks, "tq", key, txc, tid);
      continue;
    }
    clearBacklogTimeout(tn, ks, e);
    _logger.debug("NuQ FDB team pending promotion", {
      canonicalLog: "nuq-fdb/team_pending_promotion",
      queueName: ks.queueName,
      result: "promoted",
      durationMs: Date.now() - startedAt,
      nonEmptyShardCount: nonEmpty.length,
      probedShardCount: probedShards,
      staleShardCounterCount: staleShardCounters,
      selectedShard: shard,
      priority: e.p,
      queuedAgeMs: Date.now() - e.c,
    });
    return e;
  }
  _logger.debug("NuQ FDB team pending promotion", {
    canonicalLog: "nuq-fdb/team_pending_promotion",
    queueName: ks.queueName,
    result: "empty",
    durationMs: Date.now() - startedAt,
    nonEmptyShardCount: nonEmpty.length,
    probedShardCount: probedShards,
    staleShardCounterCount: staleShardCounters,
  });
  return null;
}

// Like popCrawlPending, key-pending is a single range: concurrent finishers of
// the same key conflict on the head, but per-key concurrency is small by
// definition (it is the key's limit), so the retry pressure stays bounded.
export async function popKeyPending(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  kid: string,
  txc: TxContext,
): Promise<QueueEntry | null> {
  const r = ks.keyPendingRange(kid);
  for (let skipped = 0; skipped < MAX_CORRUPT_PENDING_SKIPS; skipped++) {
    const head = await tn.getRangeAll(r.begin, r.end, { limit: 1 });
    if (head.length === 0) {
      return null;
    }
    const [key, value] = head[0];
    const e = decodeJson(value, queueEntrySchema, "nuq-fdb.queueEntry");
    tn.clear(key);
    tn.add(ks.keyPendingCount(kid), MINUS_ONE);
    if (!e) {
      await failCorruptPendingEntry(tn, ks, "kq", key, txc);
      continue;
    }
    tn.add(ks.teamPendingCount(e.o), MINUS_ONE);
    clearBacklogTimeout(tn, ks, e);
    return e;
  }
  tn.set(ks.taskKeyRaise(kid), EMPTY);
  return null;
}

export async function popCrawlPending(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  gid: string,
  txc: TxContext = newTxContext(),
): Promise<QueueEntry | null> {
  const r = ks.groupPendingRange(gid);
  for (let skipped = 0; skipped < MAX_CORRUPT_PENDING_SKIPS; skipped++) {
    const head = await tn.getRangeAll(r.begin, r.end, { limit: 1 });
    if (head.length === 0) {
      return null;
    }
    const [key, value] = head[0];
    const e = decodeJson(value, queueEntrySchema, "nuq-fdb.queueEntry");
    tn.clear(key);
    tn.add(ks.groupPendingCount(gid), MINUS_ONE);
    if (!e) {
      await failCorruptPendingEntry(tn, ks, "gq", key, txc);
      continue;
    }
    tn.add(ks.teamPendingCount(e.o), MINUS_ONE);
    clearBacklogTimeout(tn, ks, e);
    return e;
  }
  return null;
}

// === Slot release + inline promotion chain
//
// Slots are handed off one-for-one: a released slot goes to a pending head in
// the same transaction whenever possible, so this function never does a
// conflicting read of the team active counter on the handoff path.
//
// The gate chain is crawl -> key -> team -> ready. A job entering an inner
// gate keeps the outer slots it already won.
//
// `held` describes which slots the leaving job actually holds:
//  - active / ready jobs: team + key (if key-gated) + crawl (if crawl-gated)
//  - team-pending jobs: key + crawl only
//  - key-pending / delayed jobs: crawl only
//  - crawl-pending jobs: none

export async function releaseSlotsAndPromote(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  e: QueueEntry,
  held: { team: boolean; key: boolean; crawl: boolean },
  now: number,
  txc: TxContext,
): Promise<void> {
  if (!(e.f & F_GATED)) {
    return;
  }
  const tid = e.o;

  const heldKeyId = held.key && e.f & F_KEY_GATED ? e.k : undefined;
  const heldGroupId = held.crawl && e.f & F_CRAWL_GATED ? e.g : undefined;
  if (!held.team && !heldKeyId && !heldGroupId) {
    return;
  }

  // Limit-lowering convergence: if the team is over its limit, don't hand off.
  let overLimit = false;
  if (held.team) {
    const limitBuf = await tn.get(ks.teamLimit(tid)); // cold key, rarely written
    if (limitBuf) {
      const limit = decodeI64(limitBuf);
      const snapActive = decodeI64(await tn.snapshot().get(ks.teamActive(tid)));
      overLimit = snapActive > limit;
    }
  }

  let teamHead: QueueEntry | null | "consumed" = null;
  if (held.team && !overLimit) {
    teamHead = await popTeamPending(tn, ks, tid, txc);
  }
  // whether the freed team slot is still unassigned after the pops so far
  const teamSlotFree = () => held.team && !overLimit && teamHead === null;

  // Key slot handoff: promote the key-pending head into the team gate. Runs
  // before the crawl handoff so the longest-gated job gets the slot first.
  let keyHandedOff = false;
  if (heldKeyId) {
    let keyOverLimit = false;
    const kLimitBuf = await tn.get(ks.keyLimit(heldKeyId)); // cold key
    if (kLimitBuf) {
      const kLimit = decodeI64(kLimitBuf);
      const kActive = decodeI64(
        await tn.snapshot().get(ks.keyActive(heldKeyId)),
      );
      keyOverLimit = kActive > kLimit;
    }
    if (keyOverLimit) {
      // limit-lowering convergence: swallow the slot instead of handing off
      tn.add(ks.keyActive(heldKeyId), MINUS_ONE);
      keyHandedOff = true; // accounted for; don't decrement again below
    } else {
      const keyHead = await popKeyPending(tn, ks, heldKeyId, txc);
      if (keyHead) {
        keyHandedOff = true;
        // the key head now owns the freed key slot; it still needs a team slot
        if (teamSlotFree()) {
          promoteEntryToReady(tn, ks, keyHead, txc);
          teamHead = "consumed";
        } else if (!held.team) {
          await admitThroughTeamGate(tn, ks, keyHead, txc);
        } else {
          const loc = appendTeamPending(tn, ks, keyHead);
          setStatusPending(tn, ks, keyHead.i, loc);
        }
      }
    }
  }

  // Crawl slot handoff: promote the crawl-pending head out of the crawl gate.
  let crawlPromoted: QueueEntry | null = null;
  let crawlDelaySeconds = 0;
  if (heldGroupId) {
    const gMeta = decodeJson(
      await tn.snapshot().get(ks.groupMeta(heldGroupId)),
      groupMetaSchema,
      "nuq-fdb.groupMeta",
    );
    if (gMeta && gMeta.s === "active") {
      crawlPromoted = await popCrawlPending(tn, ks, heldGroupId, txc);
      if (crawlPromoted) {
        crawlDelaySeconds = gMeta.d ?? 0;
      } else {
        tn.add(ks.groupCrawlActive(heldGroupId), MINUS_ONE);
      }
    } else {
      tn.add(ks.groupCrawlActive(heldGroupId), MINUS_ONE);
    }
  }

  if (crawlPromoted) {
    const j2 = crawlPromoted;
    if (crawlDelaySeconds > 0) {
      // crawl delay: park with a not-before timestamp; keeps the crawl slot
      // only (the key gate is passed on wake-up).
      const notBefore = now + crawlDelaySeconds * 1000;
      tn.set(ks.delayed(timeBucket(j2.i), notBefore, j2.i), encodeJson(j2));
      setStatusPending(tn, ks, j2.i, { k: "dl", at: notBefore });
    } else {
      // key gate for the crawl-promoted job
      const j2KeyId = j2.f & F_KEY_GATED ? j2.k : undefined;
      let hasKeySlot = !j2KeyId;
      if (j2KeyId) {
        if (heldKeyId && !keyHandedOff && j2KeyId === heldKeyId) {
          // the freed key slot goes directly to the crawl-promoted job
          keyHandedOff = true;
          hasKeySlot = true;
        } else {
          // rare path: acquire on its own (conflicting read of keyActive)
          const kLimitBuf = await tn.get(ks.keyLimit(j2KeyId));
          const kLimit = kLimitBuf ? decodeI64(kLimitBuf) : Infinity;
          const kActive = decodeI64(await tn.get(ks.keyActive(j2KeyId)));
          if (kActive < kLimit) {
            tn.add(ks.keyActive(j2KeyId), ONE);
            hasKeySlot = true;
          }
        }
      }
      if (!hasKeySlot) {
        // waits in the key gate; keeps the crawl slot
        const loc = appendKeyPending(tn, ks, j2);
        setStatusPending(tn, ks, j2.i, loc);
      } else if (teamSlotFree()) {
        // the freed team slot goes directly to the crawl-promoted job
        promoteEntryToReady(tn, ks, j2, txc);
        teamHead = "consumed";
      } else if (!held.team) {
        // no team slot was freed here (job removal/cancellation paths), so the
        // promoted job must be admitted through the gate on its own
        await admitThroughTeamGate(tn, ks, j2, txc);
      } else {
        // waits in the team gate; keeps the crawl + key slots
        const loc = appendTeamPending(tn, ks, j2);
        setStatusPending(tn, ks, j2.i, loc);
      }
    }
  }

  if (heldKeyId && !keyHandedOff) {
    tn.add(ks.keyActive(heldKeyId), MINUS_ONE);
  }

  if (held.team) {
    if (teamHead === "consumed") {
      // slot handed to the key head or crawlPromoted above
    } else if (teamHead !== null) {
      promoteEntryToReady(tn, ks, teamHead, txc);
    } else {
      bumpTeamActive(tn, ks, tid, -1);
    }
  }
}

// Admits an entry holding no team slot through the team gate, used when a job
// enters the team gate outside of a one-for-one handoff (delayed promotion,
// limit raise). Does a conflicting read of the team active counter -- callers
// are rare paths.
export async function admitThroughTeamGate(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  e: QueueEntry,
  txc: TxContext,
): Promise<void> {
  const limitBuf = await tn.get(ks.teamLimit(e.o));
  const limit = limitBuf ? decodeI64(limitBuf) : Infinity;
  const active = decodeI64(await tn.get(ks.teamActive(e.o)));
  if (active < limit) {
    bumpTeamActive(tn, ks, e.o, 1);
    promoteEntryToReady(tn, ks, e, txc);
  } else {
    const loc = appendTeamPending(tn, ks, e);
    setStatusPending(tn, ks, e.i, loc);
  }
}

// Admits an entry holding only its crawl slot through the key gate and then
// the team gate (delayed promotion wake-up). Conflicting reads; rare path.
export async function admitThroughGates(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  e: QueueEntry,
  txc: TxContext,
): Promise<void> {
  if (e.k && e.f & F_KEY_GATED) {
    const kLimitBuf = await tn.get(ks.keyLimit(e.k));
    const kLimit = kLimitBuf ? decodeI64(kLimitBuf) : Infinity;
    const kActive = decodeI64(await tn.get(ks.keyActive(e.k)));
    if (kActive >= kLimit) {
      const loc = appendKeyPending(tn, ks, e);
      setStatusPending(tn, ks, e.i, loc);
      return;
    }
    tn.add(ks.keyActive(e.k), ONE);
  }
  await admitThroughTeamGate(tn, ks, e, txc);
}

// === Job record cleanup

export function deleteJobRecords(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  id: string,
): void {
  const r = ks.jobRange(id);
  tn.clearRange(r.begin, r.end);
}

const CORRUPT_PENDING_ENTRY_REASON = "Corrupt pending queue entry";

export async function failCorruptPendingEntry(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  queue: "tq" | "kq" | "gq" | "dl",
  key: Buffer,
  txc: TxContext,
  ownerId?: string,
): Promise<void> {
  const id = ks.unpackId(key);
  const now = Date.now();
  const [metaBuf, stBuf] = await Promise.all([
    tn.get(ks.jobMeta(id)),
    tn.get(ks.jobStatus(id)),
  ]);
  const meta = decodeJson(metaBuf, jobMetaSchema, "nuq-fdb.jobMeta");
  const st = decodeJson(stBuf, jobStatusRecordSchema, "nuq-fdb.jobStatus");

  _logger.warn(
    "Dropping corrupt NuQ FDB pending queue entry",
    meta
      ? {
          queueName: ks.queueName,
          queue,
          jobId: id,
          status: st?.s,
          zeroDataRetention: Boolean(meta.f & F_ZDR),
        }
      : {
          queueName: ks.queueName,
          queue,
          status: st?.s,
        },
  );

  if (queue === "kq" || queue === "gq") {
    const resolvedOwner = meta?.o ?? ownerId;
    if (resolvedOwner) {
      tn.add(ks.teamPendingCount(resolvedOwner), MINUS_ONE);
    }
  }

  if (st?.s !== "pending" || (st.loc && st.loc.k !== queue)) {
    return;
  }

  if (queue !== "dl" && meta?.to !== undefined) {
    clearBacklogTimeout(tn, ks, { i: id, to: meta.to });
  }

  tn.set(
    ks.jobStatus(id),
    encodeJson({
      s: "failed",
      st: st.st,
      fa: now,
    } satisfies JobStatusRecord),
  );
  tn.set(
    ks.jobFailedReason(id),
    Buffer.from(CORRUPT_PENDING_ENTRY_REASON, "utf8"),
  );

  if (meta) {
    if (meta.f & F_ZDR) {
      const dataRange = ks.jobDataRange(id);
      tn.clearRange(dataRange.begin, dataRange.end);
    }
    if (queue !== "gq" && meta.f & F_GATED) {
      const entry: QueueEntry = {
        i: id,
        o: meta.o,
        g: meta.g,
        k: meta.k,
        p: meta.p,
        f: meta.f,
        c: meta.c,
        to: meta.to,
      };
      await releaseSlotsAndPromote(
        tn,
        ks,
        entry,
        { team: false, key: queue === "tq", crawl: true },
        now,
        txc,
      );
    }
    if (meta.g && meta.f & F_GACC) {
      setGroupJobIndex(tn, ks, meta.g, id, !!(meta.f & F_COUNTABLE), "failed");
      if (meta.f & F_COUNTABLE) {
        bumpGroupStatusCount(tn, ks, meta.g, "pending", -1);
        bumpGroupStatusCount(tn, ks, meta.g, "failed", 1);
      }
      tn.add(ks.groupRemaining(meta.g), MINUS_ONE);
      tn.set(ks.taskGroupFinish(meta.g), EMPTY);
    } else if (!meta.g) {
      tn.set(
        ks.jobExpiry(timeBucket(id), now + FAILED_STANDALONE_RETENTION_MS, id),
        EMPTY,
      );
    }
  } else {
    tn.set(
      ks.jobExpiry(timeBucket(id), now + FAILED_STANDALONE_RETENTION_MS, id),
      EMPTY,
    );
  }
}

// === Group accounting helpers

export const groupJobIndexValueSchema = z.object({
  m: z.number(), // 1 if countable (single_urls)
  s: z.string(), // job status
});

export type GroupJobIndexValue = z.infer<typeof groupJobIndexValueSchema>;

export function setGroupJobIndex(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  gid: string,
  id: string,
  countable: boolean,
  status: string,
): void {
  tn.set(
    ks.groupJob(gid, id),
    encodeJson({
      m: countable ? 1 : 0,
      s: status,
    } satisfies GroupJobIndexValue),
  );
}

export function bumpGroupStatusCount(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  gid: string,
  status: string,
  delta: 1 | -1,
): void {
  tn.add(ks.groupStatusCount(gid, status), delta === 1 ? ONE : MINUS_ONE);
}
