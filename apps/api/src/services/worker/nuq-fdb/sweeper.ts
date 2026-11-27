import { randomUUID } from "node:crypto";
import type { Logger } from "winston";
import { z } from "zod";
import { logger as _logger } from "../../../lib/logger";
import { getNuqFdbDatabase } from "./client";
import type { NuqFdbGroupOps } from "./groups";
import type {
  NuqFdbKeyspace,
  JobMeta,
  JobStatusRecord,
  QueueEntry,
} from "./keyspace";
import {
  decodeI64,
  encodeI64,
  decodeJson,
  encodeJson,
  groupMetaSchema,
  jobMetaSchema,
  jobStatusRecordSchema,
  queueEntrySchema,
  timeBucket,
  TIME_BUCKETS,
  F_CRAWL_GATED,
  F_COUNTABLE,
  F_GACC,
  F_KEY_GATED,
} from "./keyspace";
import {
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
  failCorruptPendingEntry,
  popTeamPending,
  popKeyPending,
  bumpGroupStatusCount,
  bumpTeamActive,
  groupJobIndexValueSchema,
} from "./ops";
import type { NuqFdbExternalSlots } from "./slots";

type SweepableQueue = {
  readonly queueName: string;
  readonly ks: NuqFdbKeyspace;
  readonly groupOps: NuqFdbGroupOps | null;
};

const sweeperLockRecordSchema = z.object({
  w: z.string(),
  x: z.number(),
});

const leaseRecordSchema = z.object({
  l: z.string(),
});

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
  due: Array<[Buffer, Buffer]>,
  now: number,
): void {
  stats.dueCount += due.length;
  if (due.length >= SWEEP_BATCH) {
    stats.saturatedBucketCount++;
  }
  for (const [key] of due) {
    const dueAt = Number(ks.unpackId(key, 1));
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
  queue: SweepableQueue,
  index: "lease" | "backlog_timeout" | "delay",
  stats: SweepLagStats,
): void {
  if (stats.dueCount === 0 && stats.saturatedBucketCount === 0) {
    return;
  }
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
    public readonly queues: Array<SweepableQueue>,
    public readonly externalSlots: Array<NuqFdbExternalSlots> = [],
  ) {}

  private get db() {
    return getNuqFdbDatabase();
  }

  private get lockKs(): NuqFdbKeyspace {
    return this.queues[0].ks;
  }

  public async tryAcquireLock(now: number = Date.now()): Promise<boolean> {
    return await this.db.doTn(async tn => {
      const rec = decodeJson(
        await tn.get(this.lockKs.sweeperLock()),
        sweeperLockRecordSchema,
        "nuq-fdb.sweeperLock",
      );
      if (rec && rec.x > now && rec.w !== this.sweeperId) {
        return false;
      }
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
      await this.sweepLeases(queue, now, logger);
      await this.sweepBacklogTimeouts(queue, now, logger);
      await this.sweepDelayed(queue, now, logger);
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
    if (this.loop) {
      return;
    }
    this.loop = setInterval(() => {
      void (async () => {
        if (this.running) {
          return;
        }
        this.running = true;
        try {
          if (await this.tryAcquireLock()) {
            await this.sweepOnce(logger);
          }
        } catch (error: unknown) {
          logger.warn("NuQ FDB sweeper tick failed", {
            module: "nuq-fdb/sweeper",
            error,
          });
        } finally {
          this.running = false;
        }
      })();
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
    queue: SweepableQueue,
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
        const id = ks.unpackId(key);
        const lease = decodeJson(
          value,
          leaseRecordSchema,
          "nuq-fdb.leaseRecord",
        );
        await this.db.doTn(async tn => {
          const txc = newTxContext();
          const st = decodeJson(
            await tn.get(ks.jobStatus(id)),
            jobStatusRecordSchema,
            "nuq-fdb.jobStatus",
          );
          // stale entries: job moved on (renewal, finish) or was reaped already
          if (!st || st.s !== "active" || st.l !== lease?.l) {
            tn.clear(key);
            return;
          }
          if (st.e !== undefined && st.e > now) {
            // renewed after our snapshot; the old index entry is what expired
            tn.clear(key);
            return;
          }
          const meta = decodeJson(
            await tn.get(ks.jobMeta(id)),
            jobMetaSchema,
            "nuq-fdb.jobMeta",
          );
          tn.clear(key);
          if (!meta) {
            return;
          }
          const entry = entryFromMeta(id, meta);

          if (st.st < MAX_STALLS) {
            // requeue directly to ready -- the job retains its slots
            pushReady(tn, ks, entry, txc);
            setStatusQueued(tn, ks, id, st.st + 1);
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
    queue: SweepableQueue,
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
        const id = ks.unpackId(key);
        await this.db.doTn(async tn => {
          const txc = newTxContext();
          tn.clear(key);
          const st = decodeJson(
            await tn.get(ks.jobStatus(id)),
            jobStatusRecordSchema,
            "nuq-fdb.jobStatus",
          );
          if (!st || st.s !== "pending" || !st.loc) {
            return;
          }
          const meta = decodeJson(
            await tn.get(ks.jobMeta(id)),
            jobMetaSchema,
            "nuq-fdb.jobMeta",
          );
          if (!meta) {
            return;
          }
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
            if (meta.f & F_COUNTABLE) {
              bumpGroupStatusCount(tn, ks, meta.g, "pending", -1);
            }
            tn.set(ks.taskGroupFinish(meta.g), EMPTY);
          }
          deleteJobRecords(tn, ks, id);
        });
        stats.processedCount++;
      }
    }
    stats.durationMs = Date.now() - startedAt;
    logSweepLag(logger, queue, "backlog_timeout", stats);
  }

  // === Delayed (crawl delay) promotions

  private async sweepDelayed(
    queue: SweepableQueue,
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
        const e = decodeJson(value, queueEntrySchema, "nuq-fdb.queueEntry");
        if (!e) {
          await this.db.doTn(async tn => {
            const txc = newTxContext();
            tn.clear(key);
            await failCorruptPendingEntry(tn, ks, "dl", key, txc);
          });
          continue;
        }
        await this.db.doTn(async tn => {
          const txc = newTxContext();
          const st = decodeJson(
            await tn.get(ks.jobStatus(e.i)),
            jobStatusRecordSchema,
            "nuq-fdb.jobStatus",
          );
          tn.clear(key);
          if (!st || st.s !== "pending" || st.loc?.k !== "dl") {
            return;
          }
          // the job already holds its crawl slot; admit through the key gate
          // and then the team gate
          await admitThroughGates(tn, ks, e, txc);
        });
        stats.processedCount++;
      }
    }
    stats.durationMs = Date.now() - startedAt;
    logSweepLag(logger, queue, "delay", stats);
  }

  // === Group finish detection (backstop for the inline path)

  private async sweepGroupFinishTasks(
    queue: SweepableQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const groupOps = queue.groupOps;
    if (!groupOps) {
      return;
    }
    const ks = queue.ks;
    const r = ks.taskGroupFinishRange();
    const tasks = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(r.begin, r.end, { limit: 200 }),
    );
    for (const [key] of tasks) {
      const gid = ks.unpackId(key);
      await this.db.doTn(async tn => {
        const txc = newTxContext();
        // normal read so a concurrent finisher's decrement forces a retry --
        // clearing the task may not race with the group draining to zero
        const rem = decodeI64(await tn.get(ks.groupRemaining(gid)));
        if (rem > 0) {
          tn.clear(key);
          return;
        }
        await groupOps.tryCompleteGroup(tn, gid, now, txc);
      });
    }
  }

  // === Lazy group cancellation cleanup

  private async sweepGroupCancelTasks(
    queue: SweepableQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    if (!queue.groupOps) {
      return;
    }
    const ks = queue.ks;
    const r = ks.taskGroupCancelRange();
    const tasks = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(r.begin, r.end, { limit: 20 }),
    );
    for (const [key] of tasks) {
      const gid = ks.unpackId(key);
      let exhausted = false;
      let begin: Buffer | null = null;
      // clean pending members in batches until none remain
      for (let rounds = 0; rounds < 50 && !exhausted; rounds++) {
        const result = await this.db.doTn(async tn => {
          const jr = ks.groupJobRange(gid);
          const rangeBegin = begin ?? jr.begin;
          const members = await tn
            .snapshot()
            .getRangeAll(rangeBegin, jr.end, { limit: 500 });
          let cleaned = 0;
          for (const [mKey, mValue] of members) {
            const gj = decodeJson(
              mValue,
              groupJobIndexValueSchema,
              "nuq-fdb.groupJobIndex",
            );
            if (!gj || gj.s !== "pending") {
              continue;
            }
            if (cleaned >= SWEEP_BATCH) {
              return { exhausted: false, nextBegin: rangeBegin };
            }
            const id = ks.unpackId(mKey);
            const st = decodeJson(
              await tn.get(ks.jobStatus(id)),
              jobStatusRecordSchema,
              "nuq-fdb.jobStatus",
            );
            if (!st || st.s !== "pending" || !st.loc) {
              // moved on; fix the index lazily
              continue;
            }
            const meta = decodeJson(
              await tn.get(ks.jobMeta(id)),
              jobMetaSchema,
              "nuq-fdb.jobMeta",
            );
            if (!meta) {
              continue;
            }
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
            // team-/key-pending/delayed members hold a crawl slot; the group
            // is cancelled so there is nothing to promote -- just release it
            if (st.loc.k !== "gq" && meta.f & F_CRAWL_GATED) {
              tn.add(ks.groupCrawlActive(gid), MINUS_ONE);
            }
            // team-pending members also hold a key slot; release it and let
            // the raise task hand it to key-pending jobs outside this group
            if (st.loc.k === "tq" && meta.k && meta.f & F_KEY_GATED) {
              tn.add(ks.keyActive(meta.k), MINUS_ONE);
              tn.set(ks.taskKeyRaise(meta.k), EMPTY);
            }
            tn.clear(mKey);
            tn.add(ks.groupRemaining(gid), MINUS_ONE);
            if (meta.f & F_COUNTABLE) {
              bumpGroupStatusCount(tn, ks, gid, "pending", -1);
            }
            deleteJobRecords(tn, ks, id);
            cleaned++;
          }
          const lastKey = members.at(-1)?.[0];
          return {
            exhausted: members.length < 500,
            nextBegin: lastKey ? keyAfter(lastKey) : jr.end,
          };
        });
        exhausted = result.exhausted;
        begin = result.nextBegin;
      }
      if (exhausted) {
        await this.db.doTn(async tn => {
          tn.clear(key);
          tn.set(ks.taskGroupFinish(gid), EMPTY);
        });
      }
    }
  }

  // === Limit raises: drain newly-available slots

  private async sweepTeamRaiseTasks(
    queue: SweepableQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const ks = queue.ks;
    const r = ks.taskTeamRaiseRange();
    const tasks = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(r.begin, r.end, { limit: 50 }),
    );
    for (const [key] of tasks) {
      const tid = ks.unpackId(key);
      const done = await this.db.doTn(async tn => {
        const txc = newTxContext();
        const limitBuf = await tn.get(ks.teamLimit(tid));
        const limit = limitBuf ? decodeI64(limitBuf) : Infinity;
        const active = decodeI64(await tn.get(ks.teamActive(tid)));
        let free = Math.min(Math.max(0, limit - active), 32);
        let promoted = 0;
        while (free > 0) {
          const e = await popTeamPending(tn, ks, tid, txc);
          if (!e) {
            break;
          }
          promoteEntryToReady(tn, ks, e, txc);
          promoted++;
          free--;
        }
        if (promoted > 0) {
          bumpTeamActive(tn, ks, tid, promoted);
        }
        // done when no free slots remain or the pending queue is drained
        return free > 0 || limit - active <= 0;
      });
      if (done) {
        await this.db.doTn(async tn => tn.clear(key));
      }
    }
  }

  // Key raises admit key-pending heads through the team gate: each promoted
  // job acquires a key slot here and a team slot (or a team-pending place)
  // in admitThroughTeamGate.
  private async sweepKeyRaiseTasks(
    queue: SweepableQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const ks = queue.ks;
    const r = ks.taskKeyRaiseRange();
    const tasks = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(r.begin, r.end, { limit: 50 }),
    );
    for (const [key] of tasks) {
      const kid = ks.unpackId(key);
      const done = await this.db.doTn(async tn => {
        const txc = newTxContext();
        const limitBuf = await tn.get(ks.keyLimit(kid));
        const limit = limitBuf ? decodeI64(limitBuf) : Infinity;
        const active = decodeI64(await tn.get(ks.keyActive(kid)));
        let free = Math.min(Math.max(0, limit - active), 32);
        let promoted = 0;
        while (free > 0) {
          const e = await popKeyPending(tn, ks, kid, txc);
          if (!e) {
            break;
          }
          await admitThroughTeamGate(tn, ks, e, txc);
          promoted++;
          free--;
        }
        if (promoted > 0) {
          tn.add(ks.keyActive(kid), encodeI64(promoted));
        }
        // done when no free slots remain or the pending queue is drained
        return free > 0 || limit - active <= 0;
      });
      if (done) {
        await this.db.doTn(async tn => tn.clear(key));
      }
    }
  }

  // === Record GC

  private async sweepJobExpiry(
    queue: SweepableQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const ks = queue.ks;
    for (let b = 0; b < TIME_BUCKETS; b++) {
      const r = ks.jobExpiryScanRange(b, now);
      const due = await this.db.doTn(async tn =>
        tn.snapshot().getRangeAll(r.begin, r.end, { limit: SWEEP_BATCH * 2 }),
      );
      if (due.length === 0) {
        continue;
      }
      await this.db.doTn(async tn => {
        for (const [key] of due) {
          const id = ks.unpackId(key);
          tn.clear(key);
          const st = decodeJson(
            await tn.get(ks.jobStatus(id)),
            jobStatusRecordSchema,
            "nuq-fdb.jobStatus",
          );
          if (
            st &&
            (st.s === "completed" || st.s === "failed" || st.s === "cancelled")
          ) {
            deleteJobRecords(tn, ks, id);
          }
        }
      });
    }
  }

  private async sweepGroupExpiry(
    queue: SweepableQueue,
    now: number,
    logger: Logger,
  ): Promise<void> {
    const groupOps = queue.groupOps;
    if (!groupOps) {
      return;
    }
    const ks = queue.ks;
    const r = ks.groupExpiryScanRange(now);
    const due = await this.db.doTn(async tn =>
      tn.snapshot().getRangeAll(r.begin, r.end, { limit: 20 }),
    );
    for (const [key] of due) {
      const gid = ks.unpackId(key);
      // delete member job records in batches, then the group's own keyspace
      let drained = false;
      for (let rounds = 0; rounds < 200 && !drained; rounds++) {
        drained = await this.db.doTn(async tn => {
          const jr = ks.groupJobRange(gid);
          const members = await tn
            .snapshot()
            .getRangeAll(jr.begin, jr.end, { limit: 200 });
          for (const [mKey] of members) {
            const id = ks.unpackId(mKey);
            deleteJobRecords(tn, ks, id);
            tn.clear(mKey);
          }
          return members.length < 200;
        });
      }
      await this.db.doTn(async tn => {
        const g = decodeJson(
          await tn.get(ks.groupMeta(gid)),
          groupMetaSchema,
          "nuq-fdb.groupMeta",
        );
        // the crawl-finished job for this group lives in the finished queue
        const fjobBuf = await tn.get(ks.groupFinishedJob(gid));
        const finishedKs = groupOps.finishedKs;
        if (fjobBuf && finishedKs) {
          const fid = fjobBuf.toString("utf8");
          deleteJobRecords(tn, finishedKs, fid);
        }
        const gr = ks.groupRange(gid);
        tn.clearRange(gr.begin, gr.end);
        if (g) {
          tn.clear(ks.ongoingGroup(g.o, gid));
        }
        tn.clear(ks.taskGroupFinish(gid));
        tn.clear(ks.taskGroupCancel(gid));
        tn.clear(key);
      });
    }
  }
}
