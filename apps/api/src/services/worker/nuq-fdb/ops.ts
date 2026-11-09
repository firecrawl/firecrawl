import type { Transaction } from "foundationdb";
import { logger as _logger } from "../../../lib/logger";
import {
  NuqFdbKeyspace,
  QueueEntry,
  JobStatusRecord,
  GroupMeta,
  PendingLoc,
  encodeI64,
  decodeI64,
  encodeJson,
  decodeJson,
  timeBucket,
  teamPendingShard,
  READY_SHARDS,
  TEAM_PENDING_SHARDS,
  F_GATED,
  F_CRAWL_GATED,
  F_COUNTABLE,
  F_KEY_GATED,
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
  if (delta === 0) return;
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
  tn.set(ks.keyPendingKey(e.k!, e.p, e.c, e.i), encodeJson(e));
  tn.add(ks.keyPendingCount(e.k!), ONE);
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
  tn.set(ks.groupPendingKey(e.g!, e.p, e.c, e.i), encodeJson(e));
  tn.add(ks.groupPendingCount(e.g!), ONE);
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
  if (loc.k === "tq")
    return ks.teamPendingKey(ownerId, loc.s, loc.p, loc.c, id);
  if (loc.k === "kq") return ks.keyPendingKey(keyId!, loc.p, loc.c, id);
  if (loc.k === "gq") return ks.groupPendingKey(groupId!, loc.p, loc.c, id);
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
    tn.add(ks.keyPendingCount(keyId!), MINUS_ONE);
    tn.add(ks.teamPendingCount(ownerId), MINUS_ONE);
  } else if (loc.k === "gq") {
    tn.add(ks.groupPendingCount(groupId!), MINUS_ONE);
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
export async function popTeamPending(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  tid: string,
): Promise<QueueEntry | null> {
  const startedAt = Date.now();
  const range = ks.teamShardCountRange(tid);
  const counts = await tn.snapshot().getRangeAll(range.begin, range.end);
  const nonEmpty: number[] = [];
  for (const [key, value] of counts) {
    if (decodeI64(value as Buffer) > 0)
      nonEmpty.push(Number(ks.unpackId(key as Buffer)));
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
    const e = decodeJson<QueueEntry>(value as Buffer)!;
    tn.clear(key as Buffer);
    tn.add(ks.teamShardCount(tid, shard), MINUS_ONE);
    tn.add(ks.teamPendingCount(tid), MINUS_ONE);
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
): Promise<QueueEntry | null> {
  const r = ks.keyPendingRange(kid);
  const head = await tn.getRangeAll(r.begin, r.end, { limit: 1 });
  if (head.length === 0) return null;
  const [key, value] = head[0];
  const e = decodeJson<QueueEntry>(value as Buffer)!;
  tn.clear(key as Buffer);
  tn.add(ks.keyPendingCount(kid), MINUS_ONE);
  tn.add(ks.teamPendingCount(e.o), MINUS_ONE);
  clearBacklogTimeout(tn, ks, e);
  return e;
}

export async function popCrawlPending(
  tn: Transaction,
  ks: NuqFdbKeyspace,
  gid: string,
): Promise<QueueEntry | null> {
  const r = ks.groupPendingRange(gid);
  const head = await tn.getRangeAll(r.begin, r.end, { limit: 1 });
  if (head.length === 0) return null;
  const [key, value] = head[0];
  const e = decodeJson<QueueEntry>(value as Buffer)!;
  tn.clear(key as Buffer);
  tn.add(ks.groupPendingCount(gid), MINUS_ONE);
  tn.add(ks.teamPendingCount(e.o), MINUS_ONE);
  clearBacklogTimeout(tn, ks, e);
  return e;
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
  if (!(e.f & F_GATED)) return;
  const tid = e.o;

  const holdsKey = held.key && !!e.k && !!(e.f & F_KEY_GATED);
  const holdsCrawl = held.crawl && !!e.g && !!(e.f & F_CRAWL_GATED);
  if (!held.team && !holdsKey && !holdsCrawl) return;

  // Limit-lowering convergence: if the team is over its limit, don't hand off.
  let overLimit = false;
  let limit = Infinity;
  if (held.team) {
    const limitBuf = await tn.get(ks.teamLimit(tid)); // cold key, rarely written
    if (limitBuf) {
      limit = decodeI64(limitBuf);
      const snapActive = decodeI64(await tn.snapshot().get(ks.teamActive(tid)));
      overLimit = snapActive > limit;
    }
  }

  let teamHead: QueueEntry | null | "consumed" = null;
  if (held.team && !overLimit) {
    teamHead = await popTeamPending(tn, ks, tid);
  }
  // whether the freed team slot is still unassigned after the pops so far
  const teamSlotFree = () => held.team && !overLimit && teamHead === null;

  // Key slot handoff: promote the key-pending head into the team gate. Runs
  // before the crawl handoff so the longest-gated job gets the slot first.
  let keyHandedOff = false;
  if (holdsKey) {
    let keyOverLimit = false;
    const kLimitBuf = await tn.get(ks.keyLimit(e.k!)); // cold key
    if (kLimitBuf) {
      const kLimit = decodeI64(kLimitBuf);
      const kActive = decodeI64(await tn.snapshot().get(ks.keyActive(e.k!)));
      keyOverLimit = kActive > kLimit;
    }
    if (keyOverLimit) {
      // limit-lowering convergence: swallow the slot instead of handing off
      tn.add(ks.keyActive(e.k!), MINUS_ONE);
      keyHandedOff = true; // accounted for; don't decrement again below
    } else {
      const keyHead = await popKeyPending(tn, ks, e.k!);
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
  if (holdsCrawl) {
    const gMeta = decodeJson<GroupMeta>(
      await tn.snapshot().get(ks.groupMeta(e.g!)),
    );
    if (gMeta && gMeta.s === "active") {
      crawlPromoted = await popCrawlPending(tn, ks, e.g!);
      if (crawlPromoted) {
        crawlDelaySeconds = gMeta.d ?? 0;
      } else {
        tn.add(ks.groupCrawlActive(e.g!), MINUS_ONE);
      }
    } else {
      tn.add(ks.groupCrawlActive(e.g!), MINUS_ONE);
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
      const j2KeyGated = !!j2.k && !!(j2.f & F_KEY_GATED);
      let hasKeySlot = !j2KeyGated;
      if (!hasKeySlot) {
        if (holdsKey && !keyHandedOff && j2.k === e.k) {
          // the freed key slot goes directly to the crawl-promoted job
          keyHandedOff = true;
          hasKeySlot = true;
        } else {
          // rare path: acquire on its own (conflicting read of keyActive)
          const kLimitBuf = await tn.get(ks.keyLimit(j2.k!));
          const kLimit = kLimitBuf ? decodeI64(kLimitBuf) : Infinity;
          const kActive = decodeI64(await tn.get(ks.keyActive(j2.k!)));
          if (kActive < kLimit) {
            tn.add(ks.keyActive(j2.k!), ONE);
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

  if (holdsKey && !keyHandedOff) {
    tn.add(ks.keyActive(e.k!), MINUS_ONE);
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

// === Group accounting helpers

export type GroupJobIndexValue = {
  m: number; // 1 if countable (single_urls)
  s: string; // job status
};

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
