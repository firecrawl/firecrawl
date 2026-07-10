import { randomUUID } from "crypto";
import { Logger } from "winston";
import { logger as _logger } from "../../../lib/logger";
import { config } from "../../../config";
import { getNuqFdbDatabase } from "./client";
import {
  NuqFdbKeyspace,
  JobMeta,
  JobStatusRecord,
  GroupMeta,
  QueueEntry,
  decodeI64,
  encodeI64,
  decodeJson,
  encodeJson,
  timeBucket,
  TIME_BUCKETS,
  F_GATED,
  F_CRAWL_GATED,
  F_COUNTABLE,
  F_GACC,
  F_KEY_GATED,
  IngestMeta,
} from "./keyspace";
import {
  ONE,
  MINUS_ONE,
  EMPTY,
  MAX_STALLS,
  FAILED_STANDALONE_RETENTION_MS,
  newTxContext,
  pushReady,
  setStatusQueued,
  promoteEntryToReady,
  clearPendingPlacement,
  releaseSlotsAndPromote,
  admitThroughTeamGate,
  admitThroughGates,
  deleteJobRecords,
  popTeamPending,
  popKeyPending,
  setGroupJobIndex,
  bumpGroupStatusCount,
  bumpTeamActive,
  GroupJobIndexValue,
  alignQueueMetricStatus,
} from "./ops";
import { NuQFdbQueue } from "./queue";
import { NuqFdbExternalSlots } from "./slots";

const SWEEP_LOCK_TTL_MS = 15_000;
const SWEEP_BATCH = 50;
const STALL_FAILED_REASON = "Job stalled too many times";

type SweepLagStats = {
  dueCount: number;
  processedCount: number;
  oldestOverdueAgeMs: number;
  saturatedBucketCount: number;
  durationMs: number;
};

function keyAfter(key: Buffer): Buffer {
  return Buffer.concat([key, Buffer.from([0])]);
}

function entryFromMeta(id: string, meta: JobMeta): QueueEntry {
  return {
    i: id,
    o: meta.o,
    g: meta.g,
    k: meta.k,
    p: meta.p,
    f: meta.f,
    c: meta.c,
    to: meta.to,
  };
}

function emptySweepLagStats(): SweepLagStats {
  return {
    dueCount: 0,
    processedCount: 0,
    oldestOverdueAgeMs: 0,
    saturatedBucketCount: 0,
    durationMs: 0,
  };
}

function addDueKeysToLagStats(
  stats: SweepLagStats,
  ks: NuqFdbKeyspace,
  due: [unknown, unknown][],
  now: number,
): void {
  stats.dueCount += due.length;
  if (due.length >= SWEEP_BATCH) stats.saturatedBucketCount++;
  for (const [key] of due) {
    const dueAt = Number(ks.unpackId(key as Buffer, 1));
    if (Number.isFinite(dueAt)) {
      stats.oldestOverdueAgeMs = Math.max(
        stats.oldestOverdueAgeMs,
        now - dueAt,
      );
    }
  }
}

function logSweepLag(
  logger: Logger,
  queue: NuQFdbQueue,
  index: "lease" | "backlog_timeout" | "delay",
  stats: SweepLagStats,
): void {
  if (stats.dueCount === 0 && stats.saturatedBucketCount === 0) return;
  logger[stats.saturatedBucketCount > 0 ? "warn" : "debug"](
    "NuQ FDB sweeper lag",
    {
      canonicalLog: "nuq-fdb/sweeper_lag",
      queueName: queue.queueName,
      index,
      timeBuckets: TIME_BUCKETS,
      sweepBatch: SWEEP_BATCH,
      ...stats,
    },
  );
}

// One sweeper services all queues against the same FDB cluster. Each queue
// gets its own pass; a leased singleton lock (held on the first queue's
// keyspace) keeps multiple candidate processes from sweeping concurrently.
export class NuqFdbSweeper {
  private readonly sweeperId = randomUUID();
  private loop: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    public readonly queues: NuQFdbQueue[],
    public readonly externalSlots: NuqFdbExternalSlots[] = [],
  ) {}

  private get db() {
    return getNuqFdbDatabase();
  }

  private get lockKs(): NuqFdbKeyspace {
    return this.queues[0].ks;
  }

  public async tryAcquireLock(now: number = Date.now()): Promise<boolean> {
    return await this.db.doTn(async tn => {
      const rec = decodeJson<{ w: string; x: number }>(
        await tn.get(this.lockKs.sweeperLock()),
      );
      if (rec && rec.x > now && rec.w !== this.sweeperId) return false;
      tn.set(
        this.lockKs.sweeperLock(),
        encodeJson({ w: this.sweeperId, x: now + SWEEP_LOCK_TTL_MS }),
      );
      return true;
    });
  }

  // Runs one full sweep over all queues. Exposed for tests; production uses
  // start(), which wraps this in the singleton lock loop.
  public async sweepOnce(logger: Logger = _logger): Promise<void> {
    const now = Date.now();
    for (const queue of this.queues) {
      await queue.backfillMetricCounts(100, config.NUQ_FDB_METRICS_V2_ACTIVATE);
      await this.sweepLeases(queue, now, logger);
      await this.sweepBacklogTimeouts(queue, now, logger);
      await this.sweepDelayed(queue, now, logger);
      await this.sweepClaimMarkers(queue, now);
      await this.sweepAbandonedIngests(queue, now);
      await this.sweepGroupFinishTasks(queue, now, logger);
      await this.sweepGroupCancelTasks(queue, now, logger);
      await this.sweepTeamRaiseTasks(queue, now, logger);
      await this.sweepKeyRaiseTasks(queue, now, logger);
      await this.sweepJobExpiry(queue, now, logger);
      await this.sweepGroupExpiry(queue, now, logger);
    }
    for (const slots of this.externalSlots) {
      await slots.sweepExpired(now, TIME_BUCKETS);
    }
  }

  public start(intervalMs: number = 1000, logger: Logger = _logger): void {
    if (this.loop) return;
    this.loop = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        if (await this.tryAcquireLock()) {
          await this.sweepOnce(logger);
        }
      } catch (error) {
        logger.warn("NuQ FDB sweeper tick failed", {
          module: "nuq-fdb/sweeper",
          error,
        });
      } finally {
        this.running = false;
      }
    }, intervalMs);
  }

  public stop(): void {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
  }

  // === Lease expiry: requeue stalled jobs, fail them after MAX_STALLS

  private async sweepLeases(
    queue: NuQFdbQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    const stats = emptySweepLagStats();
    for (let b = 0; b < TIME_BUCKETS; b++) {
      const r = ks.leaseScanRange(b, now);
      const due = await this.db.doTn(async tn =>
        tn.snapshot().getRangeAll(r.begin, r.end, { limit: SWEEP_BATCH }),
      );
      addDueKeysToLagStats(stats, ks, due, now);
      for (const [key, value] of due) {
        const id = ks.unpackId(key as Buffer);
        const lease = decodeJson<{ l: string }>(value as Buffer);
        await this.db.doTn(async tn => {
          const txc = newTxContext();
          const st = decodeJson<JobStatusRecord>(
            await tn.get(ks.jobStatus(id)),
          );
          // stale entries: job moved on (renewal, finish) or was reaped already
          if (!st || st.s !== "active" || st.l !== lease?.l) {
            tn.clear(key as Buffer);
            return;
          }
          if (st.e !== undefined && st.e > now) {
            // renewed after our snapshot; the old index entry is what expired
            tn.clear(key as Buffer);
            return;
          }
          const meta = decodeJson<JobMeta>(await tn.get(ks.jobMeta(id)));
          tn.clear(key as Buffer);
          if (!meta) return;
          const entry = entryFromMeta(id, meta);

          if (st.st < MAX_STALLS) {
            // requeue directly to ready -- the job retains its slots
            pushReady(tn, ks, entry, txc);
            setStatusQueued(tn, ks, id, st.st + 1);
            await alignQueueMetricStatus(tn, ks, id);
            if (meta.g && meta.f & F_COUNTABLE) {
              bumpGroupStatusCount(tn, ks, meta.g, "active", -1);
              bumpGroupStatusCount(tn, ks, meta.g, "queued", 1);
            }
          } else {
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
              Buffer.from(STALL_FAILED_REASON, "utf8"),
            );
            await alignQueueMetricStatus(tn, ks, id);
            if (meta.g && meta.f & F_GACC && queue.groupOps) {
              await queue.groupOps.terminalAccounting(
                tn,
                meta.g,
                id,
                "active",
                "failed",
                !!(meta.f & F_COUNTABLE),
                now,
                txc,
              );
            }
            await releaseSlotsAndPromote(
              tn,
              ks,
              entry,
              { team: true, key: true, crawl: true },
              now,
              txc,
            );
            if (!meta.g) {
              tn.set(
                ks.jobExpiry(
                  timeBucket(id),
                  now + FAILED_STANDALONE_RETENTION_MS,
                  id,
                ),
                EMPTY,
              );
            }
          }
        });
        stats.processedCount++;
      }
    }
    stats.durationMs = Date.now() - startedAt;
    logSweepLag(logger, queue, "lease", stats);
  }

  // === Backlog timeouts: silently drop pending jobs past their deadline

  private async sweepBacklogTimeouts(
    queue: NuQFdbQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    const stats = emptySweepLagStats();
    for (let b = 0; b < TIME_BUCKETS; b++) {
      const r = ks.backlogTimeoutScanRange(b, now);
      const due = await this.db.doTn(async tn =>
        tn.snapshot().getRangeAll(r.begin, r.end, { limit: SWEEP_BATCH }),
      );
      addDueKeysToLagStats(stats, ks, due, now);
      for (const [key] of due) {
        const id = ks.unpackId(key as Buffer);
        await this.db.doTn(async tn => {
          const txc = newTxContext();
          tn.clear(key as Buffer);
          const st = decodeJson<JobStatusRecord>(
            await tn.get(ks.jobStatus(id)),
          );
          if (!st || st.s !== "pending" || !st.loc) return;
          const meta = decodeJson<JobMeta>(await tn.get(ks.jobMeta(id)));
          if (!meta) return;
          clearPendingPlacement(
            tn,
            ks,
            id,
            meta.o,
            meta.g,
            meta.k,
            st.loc,
            meta.to,
          );
          if (st.loc.k !== "gq") {
            await releaseSlotsAndPromote(
              tn,
              ks,
              entryFromMeta(id, meta),
              { team: false, key: st.loc.k === "tq", crawl: true },
              now,
              txc,
            );
          }
          if (meta.g && meta.f & F_GACC && queue.groupOps) {
            tn.clear(ks.groupJob(meta.g, id));
            tn.add(ks.groupRemaining(meta.g), MINUS_ONE);
            if (meta.f & F_COUNTABLE)
              bumpGroupStatusCount(tn, ks, meta.g, "pending", -1);
            tn.set(ks.taskGroupFinish(meta.g), EMPTY);
          }
          deleteJobRecords(tn, ks, id);
          await alignQueueMetricStatus(tn, ks, id);
        });
        stats.processedCount++;
      }
    }
    stats.durationMs = Date.now() - startedAt;
    logSweepLag(logger, queue, "backlog_timeout", stats);
  }

  // === Delayed (crawl delay) promotions

  private async sweepDelayed(
    queue: NuQFdbQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    const stats = emptySweepLagStats();
    for (let b = 0; b < TIME_BUCKETS; b++) {
      const r = ks.delayedScanRange(b, now);
      const due = await this.db.doTn(async tn =>
        tn.snapshot().getRangeAll(r.begin, r.end, { limit: SWEEP_BATCH }),
      );
      addDueKeysToLagStats(stats, ks, due, now);
      for (const [key, value] of due) {
        const e = decodeJson<QueueEntry>(value as Buffer);
        if (!e) continue;
        await this.db.doTn(async tn => {
          const txc = newTxContext();
          const st = decodeJson<JobStatusRecord>(
            await tn.get(ks.jobStatus(e.i)),
          );
          tn.clear(key as Buffer);
          if (!st || st.s !== "pending" || st.loc?.k !== "dl") return;
          // the job already holds its crawl slot; admit through the key gate
          // and then the team gate
          await admitThroughGates(tn, ks, e, txc);
          await alignQueueMetricStatus(tn, ks, e.i);
        });
        stats.processedCount++;
      }
    }
    stats.durationMs = Date.now() - startedAt;
    logSweepLag(logger, queue, "delay", stats);
  }

  // === Commit-unknown claim marker GC

  private async sweepClaimMarkers(
    queue: NuQFdbQueue,
    now: number,
  ): Promise<void> {
    const ks = queue.ks;
    const range = ks.claimExpiryScanRange(now);
    const due = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(range.begin, range.end, {
        limit: SWEEP_BATCH,
      }),
    );
    if (due.length === 0) return;
    await this.db.doTn(async tn => {
      for (const [key] of due) {
        const expiryKey = key as Buffer;
        const op = ks.unpackId(expiryKey);
        const expiresAt = Number(ks.unpackId(expiryKey, 1));
        const marker = decodeJson<{ e: number }>(await tn.get(ks.claim(op)));
        if (marker && marker.e === expiresAt && marker.e <= now) {
          tn.clear(ks.claim(op));
        }
        // Always discard the observed expiry row. A mismatched/live marker has
        // its own later durable row and must survive this stale-row cleanup.
        tn.clear(expiryKey);
      }
    });
  }

  // === Abandoned resumable enqueues

  private async sweepAbandonedIngests(
    queue: NuQFdbQueue,
    now: number,
  ): Promise<void> {
    const ks = queue.ks;
    const range = ks.ingestExpiryScanRange(now);
    const due = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(range.begin, range.end, { limit: 20 }),
    );
    for (const [expiryKey] of due) {
      const op = ks.unpackId(expiryKey as Buffer);
      await this.db.doTn(async tn => {
        const meta = decodeJson<IngestMeta>(await tn.get(ks.ingest(op)));
        if (!meta) {
          tn.clear(expiryKey as Buffer);
          return;
        }
        const jobsRange = ks.ingestJobRange(op);
        const members = await tn.getRangeAll(jobsRange.begin, jobsRange.end, {
          limit: SWEEP_BATCH,
        });
        for (const [memberKey] of members) {
          const id = ks.unpackId(memberKey as Buffer);
          const status = decodeJson<JobStatusRecord>(
            await tn.get(ks.jobStatus(id)),
          );
          if (status?.s === "ingesting" && status.op === op) {
            deleteJobRecords(tn, ks, id);
            await alignQueueMetricStatus(tn, ks, id);
          }
          tn.clear(memberKey as Buffer);
        }
        if (members.length >= SWEEP_BATCH) return;

        const groupsRange = ks.ingestGroupRange(op);
        const groups = await tn.getRangeAll(
          groupsRange.begin,
          groupsRange.end,
          { limit: SWEEP_BATCH },
        );
        for (const [groupKey] of groups) {
          const gid = ks.unpackId(groupKey as Buffer);
          tn.clear(groupKey as Buffer);
          tn.add(ks.groupIngestCount(gid), MINUS_ONE);
          tn.set(ks.taskGroupFinish(gid), EMPTY);
        }
        if (groups.length >= SWEEP_BATCH) return;

        if (meta.r > 0 && meta.o) {
          tn.add(ks.teamIngestReserved(meta.o), encodeI64(-meta.r));
        }
        tn.clear(ks.ingest(op));
        tn.clear(expiryKey as Buffer);
      });
    }
  }

  // === Group finish detection (backstop for the inline path)

  private async sweepGroupFinishTasks(
    queue: NuQFdbQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    if (!queue.groupOps) return;
    const ks = queue.ks;
    const r = ks.taskGroupFinishRange();
    const tasks = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(r.begin, r.end, { limit: 200 }),
    );
    for (const [key] of tasks) {
      const gid = ks.unpackId(key as Buffer);
      await this.db.doTn(async tn => {
        const txc = newTxContext();
        // normal read so a concurrent finisher's decrement forces a retry --
        // clearing the task may not race with the group draining to zero
        const rem = decodeI64(await tn.get(ks.groupRemaining(gid)));
        if (rem > 0) {
          tn.clear(key as Buffer);
          return;
        }
        await queue.groupOps!.tryCompleteGroup(tn, gid, now, txc);
      });
    }
  }

  // === Lazy group cancellation cleanup

  private async sweepGroupCancelTasks(
    queue: NuQFdbQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    if (!queue.groupOps) return;
    const ks = queue.ks;
    const r = ks.taskGroupCancelRange();
    const tasks = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(r.begin, r.end, { limit: 20 }),
    );
    for (const [key] of tasks) {
      const gid = ks.unpackId(key as Buffer);
      let exhausted = false;
      // The task value is a durable cursor. A concurrent cancelled-group
      // enqueue resets it to EMPTY and conflicts with this normal read, so a
      // newly inserted member can never be skipped behind the cursor.
      for (let rounds = 0; rounds < 50 && !exhausted; rounds++) {
        exhausted = await this.db.doTn(async tn => {
          const cursor = await tn.get(key as Buffer);
          if (!cursor) return true;
          const jr = ks.groupJobRange(gid);
          const rangeBegin = cursor.length > 0 ? keyAfter(cursor) : jr.begin;
          const members = await tn
            .snapshot()
            .getRangeAll(rangeBegin, jr.end, { limit: 500 });
          let cleaned = 0;
          let lastExamined: Buffer | undefined;
          for (const [mKey, mValue] of members) {
            lastExamined = mKey as Buffer;
            const gj = decodeJson<GroupJobIndexValue>(mValue as Buffer);
            if (!gj || gj.s !== "pending") continue;
            const id = ks.unpackId(mKey as Buffer);
            const st = decodeJson<JobStatusRecord>(
              await tn.get(ks.jobStatus(id)),
            );
            if (!st || st.s !== "pending" || !st.loc) continue;
            const meta = decodeJson<JobMeta>(await tn.get(ks.jobMeta(id)));
            if (!meta) continue;
            clearPendingPlacement(
              tn,
              ks,
              id,
              meta.o,
              meta.g,
              meta.k,
              st.loc,
              meta.to,
            );
            if (st.loc.k !== "gq" && meta.f & F_CRAWL_GATED) {
              tn.add(ks.groupCrawlActive(gid), MINUS_ONE);
            }
            if (st.loc.k === "tq" && meta.k && meta.f & F_KEY_GATED) {
              tn.add(ks.keyActive(meta.k), MINUS_ONE);
              tn.set(ks.taskKeyRaise(meta.k), EMPTY);
            }
            tn.clear(mKey as Buffer);
            tn.add(ks.groupRemaining(gid), MINUS_ONE);
            if (meta.f & F_COUNTABLE)
              bumpGroupStatusCount(tn, ks, gid, "pending", -1);
            deleteJobRecords(tn, ks, id);
            await alignQueueMetricStatus(tn, ks, id);
            cleaned++;
            if (cleaned >= SWEEP_BATCH) break;
          }
          const done = members.length < 500 && cleaned < SWEEP_BATCH;
          if (done) {
            tn.clear(key as Buffer);
            tn.set(ks.taskGroupFinish(gid), EMPTY);
          } else if (lastExamined) {
            tn.set(key as Buffer, lastExamined);
          }
          return done;
        });
      }
    }
  }

  // === Limit raises: drain newly-available slots

  private async sweepTeamRaiseTasks(
    queue: NuQFdbQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const ks = queue.ks;
    const r = ks.taskTeamRaiseRange();
    const tasks = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(r.begin, r.end, { limit: 50 }),
    );
    for (const [key] of tasks) {
      const tid = ks.unpackId(key as Buffer);
      await this.db.doTn(async tn => {
        // Consume the generation in the same conflicting transaction as the
        // drain so a concurrent raiser cannot have its signal cleared later.
        if (!(await tn.get(key as Buffer))) return;
        const txc = newTxContext();
        const limitBuf = await tn.get(ks.teamLimit(tid));
        const limit = limitBuf ? decodeI64(limitBuf) : Infinity;
        const active = decodeI64(await tn.get(ks.teamActive(tid)));
        let free = Math.min(Math.max(0, limit - active), 32);
        let promoted = 0;
        while (free > 0) {
          const e = await popTeamPending(tn, ks, tid);
          if (!e) break;
          await promoteEntryToReady(tn, ks, e, txc);
          promoted++;
          free--;
        }
        if (promoted > 0) bumpTeamActive(tn, ks, tid, promoted);
        // done when no free slots remain or the pending queue is drained
        if (free > 0 || limit - active <= 0) tn.clear(key as Buffer);
      });
    }
  }

  // Key raises admit key-pending heads through the team gate: each promoted
  // job acquires a key slot here and a team slot (or a team-pending place)
  // in admitThroughTeamGate.
  private async sweepKeyRaiseTasks(
    queue: NuQFdbQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const ks = queue.ks;
    const r = ks.taskKeyRaiseRange();
    const tasks = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(r.begin, r.end, { limit: 50 }),
    );
    for (const [key] of tasks) {
      const kid = ks.unpackId(key as Buffer);
      await this.db.doTn(async tn => {
        if (!(await tn.get(key as Buffer))) return;
        const txc = newTxContext();
        const limitBuf = await tn.get(ks.keyLimit(kid));
        const limit = limitBuf ? decodeI64(limitBuf) : Infinity;
        const active = decodeI64(await tn.get(ks.keyActive(kid)));
        let free = Math.min(Math.max(0, limit - active), 32);
        let promoted = 0;
        while (free > 0) {
          const e = await popKeyPending(tn, ks, kid);
          if (!e) break;
          await admitThroughTeamGate(tn, ks, e, txc);
          promoted++;
          free--;
        }
        if (promoted > 0) tn.add(ks.keyActive(kid), encodeI64(promoted));
        // done when no free slots remain or the pending queue is drained
        if (free > 0 || limit - active <= 0) tn.clear(key as Buffer);
      });
    }
  }

  // === Record GC

  private async sweepJobExpiry(
    queue: NuQFdbQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const ks = queue.ks;
    for (let b = 0; b < TIME_BUCKETS; b++) {
      const r = ks.jobExpiryScanRange(b, now);
      const due = await this.db.doTn(async tn =>
        tn.snapshot().getRangeAll(r.begin, r.end, { limit: SWEEP_BATCH * 2 }),
      );
      if (due.length === 0) continue;
      await this.db.doTn(async tn => {
        for (const [key] of due) {
          const id = ks.unpackId(key as Buffer);
          tn.clear(key as Buffer);
          const st = decodeJson<JobStatusRecord>(
            await tn.get(ks.jobStatus(id)),
          );
          if (
            st &&
            (st.s === "completed" || st.s === "failed" || st.s === "cancelled")
          ) {
            deleteJobRecords(tn, ks, id);
          }
          await alignQueueMetricStatus(tn, ks, id);
        }
      });
    }
  }

  private async sweepGroupExpiry(
    queue: NuQFdbQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    if (!queue.groupOps) return;
    const ks = queue.ks;
    const r = ks.groupExpiryScanRange(now);
    const due = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(r.begin, r.end, { limit: 20 }),
    );
    for (const [key] of due) {
      const gid = ks.unpackId(key as Buffer);
      // delete member job records in batches, then the group's own keyspace
      let drained = false;
      for (let rounds = 0; rounds < 200 && !drained; rounds++) {
        drained = await this.db.doTn(async tn => {
          const jr = ks.groupJobRange(gid);
          const members = await tn
            .snapshot()
            .getRangeAll(jr.begin, jr.end, { limit: 200 });
          for (const [mKey] of members) {
            const id = ks.unpackId(mKey as Buffer);
            deleteJobRecords(tn, ks, id);
            await alignQueueMetricStatus(tn, ks, id);
            tn.clear(mKey as Buffer);
          }
          return members.length < 200;
        });
      }
      if (!drained) continue;
      await this.db.doTn(async tn => {
        const g = decodeJson<GroupMeta>(await tn.get(ks.groupMeta(gid)));
        // the crawl-finished job for this group lives in the finished queue
        const fjobBuf = await tn.get(ks.groupFinishedJob(gid));
        if (fjobBuf && queue.groupOps!.finishedKs) {
          const fid = fjobBuf.toString("utf8");
          const finishedKs = queue.groupOps!.finishedKs;
          deleteJobRecords(tn, finishedKs, fid);
          await alignQueueMetricStatus(tn, finishedKs, fid);
        }
        const gr = ks.groupRange(gid);
        tn.clearRange(gr.begin, gr.end);
        if (g) tn.clear(ks.ongoingGroup(g.o, gid));
        tn.clear(ks.taskGroupFinish(gid));
        tn.clear(ks.taskGroupCancel(gid));
        tn.clear(key as Buffer);
      });
    }
  }
}
