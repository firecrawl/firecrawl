import { randomUUID } from "crypto";
import type { Transaction } from "foundationdb";
import { Logger } from "winston";
import { logger as _logger } from "../../../lib/logger";
import { config } from "../../../config";
import { QueueFullError } from "../../../lib/queue-full-error";
import { getNuqFdbDatabase } from "./client";
import {
  NuqFdbKeyspace,
  NuqFdbJobStatus,
  JobMeta,
  JobStatusRecord,
  QueueEntry,
  GroupMeta,
  encodeI64,
  decodeI64,
  encodeJson,
  decodeJson,
  timeBucket,
  READY_SHARDS,
  F_GATED,
  F_CRAWL_GATED,
  F_LISTENABLE,
  F_ZDR,
  F_COUNTABLE,
  F_GACC,
  normalizeOwnerId,
} from "./keyspace";

export { normalizeOwnerId, F_GACC };
import {
  ONE,
  MINUS_ONE,
  EMPTY,
  LEASE_MS,
  MAX_STALLS,
  COMPLETED_STANDALONE_RETENTION_MS,
  FAILED_STANDALONE_RETENTION_MS,
  TxContext,
  newTxContext,
  pushReady,
  appendTeamPending,
  appendCrawlPending,
  popTeamPending,
  setStatusQueued,
  setStatusPending,
  clearPendingPlacement,
  releaseSlotsAndPromote,
  deleteJobRecords,
  setGroupJobIndex,
  bumpGroupStatusCount,
  bumpTeamActive,
  GroupJobIndexValue,
} from "./ops";
import { NuqFdbGroupOps } from "./groups";

const DATA_CHUNK_BYTES = 90 * 1024;
// FoundationDB caps transactions at 10,000,000 bytes of affected data. Keep
// enqueue batches much smaller so large payloads cannot accidentally combine
// into a commit-time transaction_too_large failure.
const FDB_TRANSACTION_BYTE_LIMIT = 10_000_000;
const ENQUEUE_BATCH_BYTE_BUDGET = 750 * 1024;
const ENQUEUE_SINGLE_JOB_BYTE_LIMIT = 8 * 1024 * 1024;
const ENQUEUE_MAX_JOBS_PER_TRANSACTION = 250;

export { QueueFullError };

type FdbKeySelector = {
  key: Buffer;
  orEqual: boolean;
  offset: number;
  _isKeySelector: true;
};

export type NuQJobStatusCompat =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "backlog";

export type NuQFdbJob<Data = any, ReturnValue = any> = {
  id: string;
  status: NuQJobStatusCompat;
  createdAt: Date;
  priority: number;
  data: Data;
  finishedAt?: Date;
  returnvalue?: ReturnValue;
  failedReason?: string;
  lock?: string;
  leaseExpiresAt?: Date;
  ownerId?: string;
  groupId?: string;
};

export type NuQFdbJobOptions = {
  priority?: number;
  listenable?: boolean;
  ownerId?: string;
  groupId?: string;
  // when set, the job bypasses both concurrency gates (kickoff jobs)
  bypassGate?: boolean;
  // backlog timeout: if the job is still waiting for a slot at this time, it
  // is silently dropped (matches the PG backlog reaper)
  timesOutAt?: Date;
};

export type NuQFdbGate = {
  // null = unlimited (self-hosted)
  teamLimit: number | null;
  queueCap: number;
};

type AddJobInput<Data> = {
  id: string;
  data: Data;
  options: NuQFdbJobOptions;
};

type PreparedAddJob<Data> = AddJobInput<Data> & {
  dataBuf: Buffer;
  dataChunks: Buffer[];
  estimatedAffectedBytes: number;
};

function chunkBuffer(buf: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) {
    chunks.push(buf.subarray(i, i + size));
  }
  return chunks.length > 0 ? chunks : [Buffer.alloc(0)];
}

function externalStatus(s: NuqFdbJobStatus): NuQJobStatusCompat | null {
  if (s === "pending") return "backlog";
  if (s === "cancelled") return null; // cancelled jobs read as gone, like PG row deletes
  return s;
}

function encodedJsonBytes(v: any): number {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

export class NuQFdbQueue<JobData = any, JobReturnValue = any> {
  public readonly ks: NuqFdbKeyspace;
  public readonly groupOps: NuqFdbGroupOps | null;
  // worker-local lease expiry tracking so renewLock can stay a blind write
  private leaseExps: Map<string, number> = new Map();

  constructor(
    public readonly queueName: string,
    public readonly options: {
      // whether jobs in this queue participate in group (crawl) accounting
      hasGroups: boolean;
      // queue that group-finish jobs are emitted into (scrape -> crawl_finished)
      finishedQueueName?: string;
      // lease duration override, used by tests
      leaseMs?: number;
    },
  ) {
    this.ks = new NuqFdbKeyspace(queueName);
    this.groupOps = options.hasGroups
      ? new NuqFdbGroupOps(
          this.ks,
          options.finishedQueueName
            ? new NuqFdbKeyspace(options.finishedQueueName)
            : null,
        )
      : null;
  }

  private get db() {
    return getNuqFdbDatabase();
  }

  private storeReturnvalueInline(): boolean {
    // cloud stores results in GCS; self-host keeps them in the queue
    return !config.GCS_BUCKET_NAME;
  }

  // === Enqueue

  public async addJob(
    id: string,
    data: JobData,
    options: NuQFdbJobOptions,
    gate: NuQFdbGate,
  ): Promise<NuQFdbJob<JobData, JobReturnValue>> {
    const [job] = await this.addJobs([{ id, data, options }], gate);
    return job;
  }

  public async addJobs(
    jobs: AddJobInput<JobData>[],
    gate: NuQFdbGate,
    logger: Logger = _logger,
  ): Promise<NuQFdbJob<JobData, JobReturnValue>[]> {
    if (jobs.length === 0) return [];
    const ownerId = normalizeOwnerId(jobs[0].options.ownerId);
    if (jobs.some(j => normalizeOwnerId(j.options.ownerId) !== ownerId)) {
      throw new Error("addJobs requires all jobs to share an owner");
    }

    const prepared = jobs.map(j => this.prepareAddJob(j, ownerId));
    const results: NuQFdbJob<JobData, JobReturnValue>[] = [];
    let batch: PreparedAddJob<JobData>[] = [];
    let batchBytes = 0;

    for (const job of prepared) {
      if (job.estimatedAffectedBytes > ENQUEUE_SINGLE_JOB_BYTE_LIMIT) {
        throw new Error(
          `NuQ FDB job ${job.id} is too large to enqueue safely: estimated ${job.estimatedAffectedBytes} bytes of affected data exceeds ${ENQUEUE_SINGLE_JOB_BYTE_LIMIT}`,
        );
      }

      if (job.estimatedAffectedBytes > ENQUEUE_BATCH_BYTE_BUDGET) {
        logger.warn("NuQ FDB enqueue job exceeds batch budget", {
          canonicalLog: "nuq-fdb/enqueue_batch",
          queueName: this.queueName,
          jobId: job.id,
          estimatedAffectedBytes: job.estimatedAffectedBytes,
          batchByteBudget: ENQUEUE_BATCH_BYTE_BUDGET,
          transactionByteLimit: FDB_TRANSACTION_BYTE_LIMIT,
        });
      }

      if (
        batch.length > 0 &&
        (batchBytes + job.estimatedAffectedBytes > ENQUEUE_BATCH_BYTE_BUDGET ||
          batch.length >= ENQUEUE_MAX_JOBS_PER_TRANSACTION)
      ) {
        results.push(...(await this.addJobsBatch(batch, ownerId, gate)));
        batch = [];
        batchBytes = 0;
      }

      batch.push(job);
      batchBytes += job.estimatedAffectedBytes;
    }

    if (batch.length > 0) {
      results.push(...(await this.addJobsBatch(batch, ownerId, gate)));
    }
    return results;
  }

  private prepareAddJob(
    job: AddJobInput<JobData>,
    ownerId: string | null,
  ): PreparedAddJob<JobData> {
    const dataBuf = Buffer.from(JSON.stringify(job.data ?? null), "utf8");
    const dataChunks = chunkBuffer(dataBuf, DATA_CHUNK_BYTES);
    const estimatedAffectedBytes = this.estimateEnqueueAffectedBytes(
      job,
      ownerId,
      dataChunks,
    );
    return {
      ...job,
      dataBuf,
      dataChunks,
      estimatedAffectedBytes,
    };
  }

  private estimateEnqueueAffectedBytes(
    job: AddJobInput<JobData>,
    ownerId: string | null,
    dataChunks: Buffer[],
  ): number {
    const ks = this.ks;
    const now = Date.now();
    const priority = job.options.priority ?? 0;
    const gid = job.options.groupId;
    const owner = ownerId ?? "";
    const entry: QueueEntry = {
      i: job.id,
      o: owner,
      g: gid,
      p: priority,
      f: F_GATED | F_CRAWL_GATED | F_LISTENABLE | F_ZDR | F_COUNTABLE | F_GACC,
      c: now,
      to: job.options.timesOutAt?.getTime(),
    };
    const meta: JobMeta = {
      c: now,
      p: priority,
      o: owner,
      g: gid,
      f: entry.f,
      to: entry.to,
      dc: dataChunks.length,
    };

    let bytes =
      ks.jobMeta(job.id).length +
      encodedJsonBytes(meta) +
      ks.jobStatus(job.id).length +
      encodedJsonBytes({ s: "pending", st: 0 }) +
      ks.readyPrefix(READY_SHARDS - 1, priority).length +
      encodedJsonBytes(entry) +
      ks.readyShardCount(READY_SHARDS - 1).length +
      8;

    for (let i = 0; i < dataChunks.length; i++) {
      bytes += ks.jobData(job.id, i).length + dataChunks[i].length;
    }

    if (owner) {
      bytes +=
        ks.teamLimit(owner).length +
        8 +
        ks.teamActive(owner).length +
        8 +
        ks.teamActiveIndex(owner).length +
        8 +
        ks.teamPendingCount(owner).length +
        8 +
        ks.teamShardCount(owner, 0).length +
        8 +
        ks.teamPendingKey(owner, 0, priority, now, job.id).length +
        encodedJsonBytes(entry);
    }

    if (gid) {
      bytes +=
        ks.groupMeta(gid).length +
        ks.groupRemaining(gid).length +
        8 +
        ks.groupCrawlActive(gid).length +
        8 +
        ks.groupStatusCount(gid, "pending").length +
        8 +
        ks.groupPendingCount(gid).length +
        8 +
        ks.groupPendingKey(gid, priority, now, job.id).length +
        encodedJsonBytes(entry) +
        ks.groupJob(gid, job.id).length +
        encodedJsonBytes({ m: 1, s: "pending" });
    }

    if (entry.to !== undefined) {
      bytes += ks.backlogTimeout(timeBucket(job.id), entry.to, job.id).length;
    }

    // Account for versionstamp suffixes, conflict ranges, tuple overhead, and
    // status loc variants. This intentionally overestimates so the batching
    // boundary stays conservative as placement changes inside the transaction.
    return bytes + 4096;
  }

  private async addJobsBatch(
    jobs: PreparedAddJob<JobData>[],
    ownerId: string | null,
    gate: NuQFdbGate,
  ): Promise<NuQFdbJob<JobData, JobReturnValue>[]> {
    const ks = this.ks;
    return await this.db.doTn(async tn => {
      const txc = newTxContext();
      const now = Date.now();
      const out: NuQFdbJob<JobData, JobReturnValue>[] = [];

      let free = Infinity;
      if (gate.teamLimit !== null && ownerId !== null) {
        const storedBuf = await tn.get(ks.teamLimit(ownerId));
        const stored = storedBuf ? decodeI64(storedBuf) : null;
        if (stored !== gate.teamLimit) {
          tn.set(ks.teamLimit(ownerId), encodeI64(gate.teamLimit));
          if (stored !== null && gate.teamLimit > stored) {
            tn.set(ks.taskTeamRaise(ownerId), EMPTY);
          }
        }

        const pend = decodeI64(
          await tn.snapshot().get(ks.teamPendingCount(ownerId)),
        );
        if (pend + jobs.length > gate.queueCap) {
          throw new QueueFullError(pend, gate.queueCap);
        }

        // big-limit teams tolerate a small admission overshoot in exchange for
        // a conflict-free read; small-limit teams get the strict read
        const active =
          gate.teamLimit >= 256
            ? decodeI64(await tn.snapshot().get(ks.teamActive(ownerId)))
            : decodeI64(await tn.get(ks.teamActive(ownerId)));
        free = Math.max(0, gate.teamLimit - active);
      }

      // crawl gate state per distinct live group
      const groupMetas = new Map<string, GroupMeta | null>();
      const crawlFree = new Map<string, number>();
      if (this.options.hasGroups) {
        for (const j of jobs) {
          const gid = j.options.groupId;
          if (!gid || groupMetas.has(gid)) continue;
          const gMeta = decodeJson<GroupMeta>(await tn.get(ks.groupMeta(gid)));
          groupMetas.set(gid, gMeta);
          if (gMeta && gMeta.s === "active" && gate.teamLimit !== null) {
            const effM = (gMeta.d ?? 0) > 0 ? 1 : gMeta.m;
            if (effM !== undefined) {
              const cact = decodeI64(await tn.get(ks.groupCrawlActive(gid)));
              crawlFree.set(gid, effM - cact);
            }
          }
        }
      }

      let granted = 0;
      const crawlAcquired = new Map<string, number>();

      for (const j of jobs) {
        const gid = j.options.groupId;
        const gMeta = gid ? groupMetas.get(gid) : null;
        const groupLive = !!gMeta && gMeta.s === "active";
        const gated = gate.teamLimit !== null && !j.options.bypassGate;
        const crawlGated = gated && !!gid && groupLive && crawlFree.has(gid!);
        const countable =
          this.options.hasGroups &&
          groupLive &&
          (j.data as any)?.mode === "single_urls";

        let flags = 0;
        if (gated) flags |= F_GATED;
        if (crawlGated) flags |= F_CRAWL_GATED;
        if (j.options.listenable) flags |= F_LISTENABLE;
        if ((j.data as any)?.zeroDataRetention) flags |= F_ZDR;
        if (countable) flags |= F_COUNTABLE;
        if (groupLive) flags |= F_GACC;

        const timesOutAt = gated ? j.options.timesOutAt?.getTime() : undefined;
        const entry: QueueEntry = {
          i: j.id,
          o: ownerId ?? "",
          g: gid,
          p: j.options.priority ?? 0,
          f: flags,
          c: now,
          to: timesOutAt,
        };

        const meta: JobMeta = {
          c: now,
          p: entry.p,
          o: entry.o,
          g: gid,
          f: flags,
          to: timesOutAt,
          dc: j.dataChunks.length,
        };
        tn.set(ks.jobMeta(j.id), encodeJson(meta));
        j.dataChunks.forEach((chunk, ci) =>
          tn.set(ks.jobData(j.id, ci), chunk),
        );

        let placedStatus: NuqFdbJobStatus;
        if (!gated) {
          pushReady(tn, ks, entry, txc);
          setStatusQueued(tn, ks, j.id);
          placedStatus = "queued";
        } else if (crawlGated && crawlFree.get(gid!)! <= 0) {
          const loc = appendCrawlPending(tn, ks, entry);
          setStatusPending(tn, ks, j.id, loc);
          placedStatus = "pending";
        } else {
          if (crawlGated) {
            crawlFree.set(gid!, crawlFree.get(gid!)! - 1);
            crawlAcquired.set(gid!, (crawlAcquired.get(gid!) ?? 0) + 1);
          }
          if (free > 0) {
            free--;
            granted++;
            pushReady(tn, ks, entry, txc);
            setStatusQueued(tn, ks, j.id);
            placedStatus = "queued";
          } else {
            const loc = appendTeamPending(tn, ks, entry);
            setStatusPending(tn, ks, j.id, loc);
            placedStatus = "pending";
          }
        }

        if (groupLive && gid) {
          tn.add(ks.groupRemaining(gid), ONE);
          setGroupJobIndex(tn, ks, gid, j.id, countable, placedStatus);
          if (countable) bumpGroupStatusCount(tn, ks, gid, placedStatus, 1);
        }

        out.push({
          id: j.id,
          status: placedStatus === "pending" ? "backlog" : "queued",
          createdAt: new Date(now),
          priority: entry.p,
          data: j.data,
          ownerId: entry.o || undefined,
          groupId: gid,
        });
      }

      if (granted > 0 && ownerId !== null) {
        bumpTeamActive(tn, ks, ownerId, granted);
      }
      for (const [gid, n] of crawlAcquired) {
        tn.add(ks.groupCrawlActive(gid), encodeI64(n));
      }

      return out;
    });
  }

  // === Take (worker dequeue)

  public async getJobToProcess(
    logger: Logger = _logger,
  ): Promise<NuQFdbJob<JobData, JobReturnValue> | null> {
    const startedAt = Date.now();
    // blind random probes win at high occupancy (no coordination, conflicts
    // spread across shards); the occupancy scan below covers the sparse case
    const PROBES = 4;
    const tried = new Set<number>();
    let randomDropped = 0;
    while (tried.size < PROBES) {
      const shard = Math.floor(Math.random() * READY_SHARDS);
      if (tried.has(shard)) continue;
      const result = await this.takeFromShard(shard);
      if (result === "empty") {
        tried.add(shard);
        continue;
      }
      if (result === "dropped") {
        // tombstone or cancelled-group divert consumed an entry; same shard
        // may hold live work, try it again without burning a probe
        randomDropped++;
        continue;
      }
      this.leaseExps.set(result.id, result.leaseExpiresAt!.getTime());
      logger.debug("NuQ FDB dequeue attempt", {
        canonicalLog: "nuq-fdb/dequeue",
        queueName: this.queueName,
        result: "job",
        path: "random_probe",
        durationMs: Date.now() - startedAt,
        readyShards: READY_SHARDS,
        randomProbeCount: tried.size + 1,
        randomEmptyCount: tried.size,
        randomDroppedCount: randomDropped,
      });
      return result;
    }

    // sparse queue: find non-empty shards via their occupancy counters
    const candidates = await this.db.doTn(async tn => {
      const r = this.ks.readyShardCountRange();
      const counts = await tn.snapshot().getRangeAll(r.begin, r.end);
      const nonEmpty: number[] = [];
      for (const [key, value] of counts) {
        if (decodeI64(value as Buffer) > 0) {
          nonEmpty.push(Number(this.ks.unpackId(key as Buffer)));
        }
      }
      return nonEmpty;
    });
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    let fallbackDropped = 0;
    let fallbackEmpty = 0;
    let fallbackAttempts = 0;
    for (const shard of candidates.slice(0, 8)) {
      if (tried.has(shard)) continue;
      for (let attempt = 0; attempt < 4; attempt++) {
        fallbackAttempts++;
        const result = await this.takeFromShard(shard);
        if (result === "empty") {
          fallbackEmpty++;
          break;
        }
        if (result === "dropped") {
          fallbackDropped++;
          continue;
        }
        this.leaseExps.set(result.id, result.leaseExpiresAt!.getTime());
        logger.debug("NuQ FDB dequeue attempt", {
          canonicalLog: "nuq-fdb/dequeue",
          queueName: this.queueName,
          result: "job",
          path: "sparse_scan",
          durationMs: Date.now() - startedAt,
          readyShards: READY_SHARDS,
          randomProbeCount: tried.size,
          randomEmptyCount: tried.size,
          randomDroppedCount: randomDropped,
          nonEmptyCandidateCount: candidates.length,
          fallbackAttemptCount: fallbackAttempts,
          fallbackEmptyCount: fallbackEmpty,
          fallbackDroppedCount: fallbackDropped,
        });
        return result;
      }
    }
    logger.debug("NuQ FDB dequeue attempt", {
      canonicalLog: "nuq-fdb/dequeue",
      queueName: this.queueName,
      result: "empty",
      path: "sparse_scan",
      durationMs: Date.now() - startedAt,
      readyShards: READY_SHARDS,
      randomProbeCount: tried.size,
      randomEmptyCount: tried.size,
      randomDroppedCount: randomDropped,
      nonEmptyCandidateCount: candidates.length,
      fallbackAttemptCount: fallbackAttempts,
      fallbackEmptyCount: fallbackEmpty,
      fallbackDroppedCount: fallbackDropped,
    });
    return null;
  }

  private async takeFromShard(
    shard: number,
  ): Promise<NuQFdbJob<JobData, JobReturnValue> | "empty" | "dropped"> {
    const ks = this.ks;
    return await this.db.doTn(async tn => {
      const txc = newTxContext();
      const now = Date.now();
      const range = ks.readyShardRange(shard);
      const head = await tn.getRangeAll(range.begin, range.end, { limit: 1 });
      if (head.length === 0) return "empty";
      const [key, value] = head[0];
      const e = decodeJson<QueueEntry>(value as Buffer)!;
      tn.clear(key as Buffer);
      tn.add(ks.readyShardCount(shard), MINUS_ONE);

      const st = decodeJson<JobStatusRecord>(await tn.get(ks.jobStatus(e.i)));
      if (!st || st.s !== "queued") {
        // tombstone (removed job) -- slots were released by the remover
        return "dropped";
      }

      if (e.g && this.options.hasGroups) {
        const gMeta = decodeJson<GroupMeta>(
          await tn.snapshot().get(ks.groupMeta(e.g)),
        );
        if (gMeta && gMeta.s === "cancelled") {
          // lazy cancellation: this job dies at take time
          if (e.f & F_GACC) {
            const gj = decodeJson<GroupJobIndexValue>(
              await tn.get(ks.groupJob(e.g, e.i)),
            );
            if (gj) {
              tn.clear(ks.groupJob(e.g, e.i));
              tn.add(ks.groupRemaining(e.g), MINUS_ONE);
              if (e.f & F_COUNTABLE)
                bumpGroupStatusCount(tn, ks, e.g, "queued", -1);
              tn.set(ks.taskGroupFinish(e.g), EMPTY);
            }
          }
          deleteJobRecords(tn, ks, e.i);
          await releaseSlotsAndPromote(
            tn,
            ks,
            e,
            { team: true, crawl: true },
            now,
            txc,
          );
          return "dropped";
        }
      }

      const meta = decodeJson<JobMeta>(
        await tn.snapshot().get(ks.jobMeta(e.i)),
      );
      if (!meta) return "dropped";
      const dataRange = ks.jobDataRange(e.i);
      const dataParts = await tn
        .snapshot()
        .getRangeAll(dataRange.begin, dataRange.end);
      const data = JSON.parse(
        Buffer.concat(dataParts.map(([, v]) => v as Buffer)).toString("utf8"),
      );

      const lock = randomUUID();
      const exp = now + (this.options.leaseMs ?? LEASE_MS);
      const rec: JobStatusRecord = { s: "active", l: lock, e: exp, st: st.st };
      tn.set(ks.jobStatus(e.i), encodeJson(rec));
      tn.set(ks.lease(timeBucket(e.i), exp, e.i), encodeJson({ l: lock }));
      if (e.g && e.f & F_COUNTABLE) {
        bumpGroupStatusCount(tn, ks, e.g, "queued", -1);
        bumpGroupStatusCount(tn, ks, e.g, "active", 1);
        setGroupJobIndex(tn, ks, e.g, e.i, true, "active");
      }

      return {
        id: e.i,
        status: "active" as const,
        createdAt: new Date(meta.c),
        priority: meta.p,
        data,
        lock,
        leaseExpiresAt: new Date(exp),
        ownerId: meta.o || undefined,
        groupId: meta.g,
      };
    });
  }

  // === Leases

  public async renewLock(
    id: string,
    lock: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const oldExp = this.leaseExps.get(id);
    if (oldExp === undefined) return false;
    const ks = this.ks;
    const newExp = Date.now() + (this.options.leaseMs ?? LEASE_MS);
    try {
      await this.db.doTn(async tn => {
        // blind writes only; the sweeper validates the lock before reaping
        tn.clear(ks.lease(timeBucket(id), oldExp, id));
        tn.set(ks.lease(timeBucket(id), newExp, id), encodeJson({ l: lock }));
        // the lease index moved, keep the status record's expiry in sync for
        // observability; only the worker holding the lock writes this
        const st = decodeJson<JobStatusRecord>(
          await tn.snapshot().get(ks.jobStatus(id)),
        );
        if (!st || st.s !== "active" || st.l !== lock) {
          throw new LockLostError();
        }
        tn.set(ks.jobStatus(id), encodeJson({ ...st, e: newExp }));
      });
    } catch (e) {
      if (e instanceof LockLostError) {
        this.leaseExps.delete(id);
        return false;
      }
      throw e;
    }
    this.leaseExps.set(id, newExp);
    return true;
  }

  // === Finish / fail

  public async jobFinish(
    id: string,
    lock: string,
    returnvalue: JobReturnValue | null,
    logger: Logger = _logger,
  ): Promise<boolean> {
    return this.finishOrFail(id, lock, "completed", returnvalue ?? null, null);
  }

  public async jobFail(
    id: string,
    lock: string,
    failedReason: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    return this.finishOrFail(id, lock, "failed", null, failedReason);
  }

  private async finishOrFail(
    id: string,
    lock: string,
    outcome: "completed" | "failed",
    returnvalue: any,
    failedReason: string | null,
  ): Promise<boolean> {
    const ks = this.ks;
    const ok = await this.db.doTn(async tn => {
      const txc = newTxContext();
      const now = Date.now();
      const st = decodeJson<JobStatusRecord>(await tn.get(ks.jobStatus(id)));
      if (!st) return false;
      // idempotency: a commit_unknown_result retry lands here
      if (st.s === outcome && st.l === lock) return true;
      if (st.s !== "active" || st.l !== lock) return false;
      const meta = decodeJson<JobMeta>(await tn.get(ks.jobMeta(id)));
      if (!meta) return false;

      const rec: JobStatusRecord = {
        s: outcome,
        l: lock,
        st: st.st,
        fa: now,
      };
      tn.set(ks.jobStatus(id), encodeJson(rec));
      if (st.e !== undefined) tn.clear(ks.lease(timeBucket(id), st.e, id));

      if (outcome === "completed") {
        if (
          returnvalue !== null &&
          this.storeReturnvalueInline() &&
          !(meta.f & F_ZDR)
        ) {
          const buf = Buffer.from(JSON.stringify(returnvalue), "utf8");
          chunkBuffer(buf, DATA_CHUNK_BYTES).forEach((chunk, ci) =>
            tn.set(ks.jobReturnvalue(id, ci), chunk),
          );
        }
      } else {
        tn.set(
          ks.jobFailedReason(id),
          Buffer.from((failedReason ?? "").slice(0, DATA_CHUNK_BYTES), "utf8"),
        );
      }

      // Shed job input data early on cloud (results live in GCS) and always for
      // ZDR. Group members are exempt on the plain cloud path: the crawl-finish
      // job recovers crawl-scoped context (v1, webhook, team_id, ...) from a
      // representative member via getGroupAnyJob, mirroring the PG backend which
      // never sheds. ZDR still sheds even for members (compliance).
      if (meta.f & F_ZDR || (config.GCS_BUCKET_NAME && !meta.g)) {
        const r = ks.jobDataRange(id);
        tn.clearRange(r.begin, r.end);
      }

      if (meta.g && meta.f & F_GACC && this.groupOps) {
        await this.groupOps.terminalAccounting(
          tn,
          meta.g,
          id,
          "active",
          outcome,
          !!(meta.f & F_COUNTABLE),
          now,
          txc,
        );
      }

      const entry: QueueEntry = {
        i: id,
        o: meta.o,
        g: meta.g,
        p: meta.p,
        f: meta.f,
        c: meta.c,
        to: meta.to,
      };
      await releaseSlotsAndPromote(
        tn,
        ks,
        entry,
        { team: true, crawl: true },
        now,
        txc,
      );

      if (!meta.g) {
        const retention =
          outcome === "completed"
            ? COMPLETED_STANDALONE_RETENTION_MS
            : FAILED_STANDALONE_RETENTION_MS;
        tn.set(ks.jobExpiry(timeBucket(id), now + retention, id), EMPTY);
      }
      return true;
    });
    if (ok) this.leaseExps.delete(id);
    return ok;
  }

  // === Reads

  private async readJob(
    tn: Transaction,
    id: string,
  ): Promise<NuQFdbJob<JobData, JobReturnValue> | null> {
    const ks = this.ks;
    const snap = tn.snapshot();
    const [metaBuf, stBuf] = await Promise.all([
      snap.get(ks.jobMeta(id)),
      snap.get(ks.jobStatus(id)),
    ]);
    const meta = decodeJson<JobMeta>(metaBuf);
    const st = decodeJson<JobStatusRecord>(stBuf);
    if (!meta || !st) return null;
    const status = externalStatus(st.s);
    if (status === null) return null;

    const dataRange = ks.jobDataRange(id);
    const dataParts = await snap.getRangeAll(dataRange.begin, dataRange.end);
    const data =
      dataParts.length > 0
        ? JSON.parse(
            Buffer.concat(dataParts.map(([, v]) => v as Buffer)).toString(
              "utf8",
            ),
          )
        : null;

    let returnvalue: any = undefined;
    if (st.s === "completed") {
      const rvRange = ks.jobReturnvalueRange(id);
      const rvParts = await snap.getRangeAll(rvRange.begin, rvRange.end);
      if (rvParts.length > 0) {
        returnvalue = JSON.parse(
          Buffer.concat(rvParts.map(([, v]) => v as Buffer)).toString("utf8"),
        );
      } else {
        returnvalue = null;
      }
    }
    let failedReason: string | undefined = undefined;
    if (st.s === "failed") {
      const frBuf = await snap.get(ks.jobFailedReason(id));
      failedReason = frBuf ? frBuf.toString("utf8") : undefined;
    }

    return {
      id,
      status,
      createdAt: new Date(meta.c),
      priority: meta.p,
      data,
      finishedAt: st.fa !== undefined ? new Date(st.fa) : undefined,
      returnvalue,
      failedReason,
      lock: st.s === "active" ? st.l : undefined,
      ownerId: meta.o || undefined,
      groupId: meta.g,
    };
  }

  public async getJob(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQFdbJob<JobData, JobReturnValue> | null> {
    return await this.db.doTn(async tn => this.readJob(tn, id));
  }

  // cheap existence probe used by the dual-backend router
  public async hasJob(id: string): Promise<boolean> {
    return await this.db.doTn(async tn => {
      const st = await tn.snapshot().get(this.ks.jobStatus(id));
      return st !== undefined && st !== null;
    });
  }

  public async getJobs(
    ids: string[],
    logger: Logger = _logger,
  ): Promise<NuQFdbJob<JobData, JobReturnValue>[]> {
    if (ids.length === 0) return [];
    const out: NuQFdbJob<JobData, JobReturnValue>[] = [];
    const BATCH = 100;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const jobs = await this.db.doTn(async tn =>
        Promise.all(batch.map(id => this.readJob(tn, id))),
      );
      out.push(
        ...jobs.filter(
          (j): j is NuQFdbJob<JobData, JobReturnValue> => j !== null,
        ),
      );
    }
    return out;
  }

  public async getJobsWithStatus(
    ids: string[],
    status: NuQJobStatusCompat,
    logger: Logger = _logger,
  ): Promise<NuQFdbJob<JobData, JobReturnValue>[]> {
    return (await this.getJobs(ids, logger)).filter(j => j.status === status);
  }

  public async getJobsWithStatuses(
    ids: string[],
    statuses: NuQJobStatusCompat[],
    logger: Logger = _logger,
  ): Promise<NuQFdbJob<JobData, JobReturnValue>[]> {
    const set = new Set(statuses);
    return (await this.getJobs(ids, logger)).filter(j => set.has(j.status));
  }

  // === Remove

  public async removeJob(
    id: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const ks = this.ks;
    return await this.db.doTn(async tn => {
      const txc = newTxContext();
      const now = Date.now();
      const st = decodeJson<JobStatusRecord>(await tn.get(ks.jobStatus(id)));
      if (!st || st.s === "cancelled") return false;
      const meta = decodeJson<JobMeta>(await tn.get(ks.jobMeta(id)));
      if (!meta) return false;
      const entry: QueueEntry = {
        i: id,
        o: meta.o,
        g: meta.g,
        p: meta.p,
        f: meta.f,
        c: meta.c,
        to: meta.to,
      };
      const countable = !!(meta.f & F_COUNTABLE);
      const accounted = !!(meta.f & F_GACC) && !!meta.g && !!this.groupOps;

      if (st.s === "pending") {
        clearPendingPlacement(tn, ks, id, meta.o, meta.g, st.loc!, meta.to);
        // team-pending and delayed jobs hold a crawl slot
        if (st.loc!.k !== "gq") {
          await releaseSlotsAndPromote(
            tn,
            ks,
            entry,
            { team: false, crawl: true },
            now,
            txc,
          );
        }
        if (accounted) {
          tn.clear(ks.groupJob(meta.g!, id));
          tn.add(ks.groupRemaining(meta.g!), MINUS_ONE);
          if (countable) bumpGroupStatusCount(tn, ks, meta.g!, "pending", -1);
          tn.set(ks.taskGroupFinish(meta.g!), EMPTY);
        }
        deleteJobRecords(tn, ks, id);
      } else if (st.s === "queued" || st.s === "active") {
        tn.set(
          ks.jobStatus(id),
          encodeJson({ s: "cancelled", st: st.st } satisfies JobStatusRecord),
        );
        if (st.s === "active" && st.e !== undefined) {
          tn.clear(ks.lease(timeBucket(id), st.e, id));
        }
        await releaseSlotsAndPromote(
          tn,
          ks,
          entry,
          { team: true, crawl: true },
          now,
          txc,
        );
        if (accounted) {
          tn.clear(ks.groupJob(meta.g!, id));
          tn.add(ks.groupRemaining(meta.g!), MINUS_ONE);
          if (countable) bumpGroupStatusCount(tn, ks, meta.g!, st.s, -1);
          tn.set(ks.taskGroupFinish(meta.g!), EMPTY);
        }
        // status tombstone stays for take-side dedupe; sweeper GCs the records
        tn.set(
          ks.jobExpiry(
            timeBucket(id),
            now + COMPLETED_STANDALONE_RETENTION_MS,
            id,
          ),
          EMPTY,
        );
      } else {
        // terminal: drop the records, like the PG row delete
        if (accounted) {
          tn.clear(ks.groupJob(meta.g!, id));
          if (countable) bumpGroupStatusCount(tn, ks, meta.g!, st.s, -1);
        }
        deleteJobRecords(tn, ks, id);
      }
      return true;
    });
  }

  public async removeJobs(
    ids: string[],
    logger: Logger = _logger,
  ): Promise<void> {
    for (const id of ids) {
      await this.removeJob(id, logger);
    }
  }

  // === waitForJob

  public async waitForJob(
    id: string,
    timeout: number | null,
    logger: Logger = _logger,
  ): Promise<JobReturnValue> {
    const ks = this.ks;
    const deadline = timeout !== null ? Date.now() + timeout : null;
    while (true) {
      const { st, watch } = await this.db.doTn(async tn => {
        const stBuf = await tn.get(ks.jobStatus(id));
        const st = decodeJson<JobStatusRecord>(stBuf);
        if (
          st &&
          (st.s === "completed" || st.s === "failed" || st.s === "cancelled")
        ) {
          return { st, watch: null };
        }
        return { st, watch: tn.watch(ks.jobStatus(id)) };
      });

      if (!st) {
        if (watch) watch.cancel();
        throw new Error("Job raced out while waiting for it");
      }

      if (st.s === "completed") {
        if (watch) watch.cancel();
        const job = await this.getJob(id, logger);
        if (!job) throw new Error("Job raced out while waiting for it");
        return job.returnvalue!;
      }
      if (st.s === "failed") {
        if (watch) watch.cancel();
        const job = await this.getJob(id, logger);
        throw new Error(job?.failedReason ?? "Job failed");
      }
      if (st.s === "cancelled") {
        if (watch) watch.cancel();
        throw new Error("Job raced out while waiting for it");
      }

      const remaining = deadline !== null ? deadline - Date.now() : null;
      if (remaining !== null && remaining <= 0) {
        watch!.cancel();
        throw new Error("Timed out");
      }

      const fired = await Promise.race([
        watch!.promise.then(() => true),
        new Promise<false>(resolve =>
          setTimeout(
            () => resolve(false),
            remaining !== null ? Math.min(remaining, 30_000) : 30_000,
          ),
        ),
      ]);
      if (!fired) {
        watch!.cancel();
        if (deadline !== null && Date.now() >= deadline) {
          throw new Error("Timed out");
        }
      }
    }
  }

  // === Group-scoped reads

  public async getGroupNumericStats(
    groupId: string,
    logger: Logger = _logger,
  ): Promise<Record<NuQJobStatusCompat, number>> {
    const ks = this.ks;
    return await this.db.doTn(async tn => {
      const r = ks.groupStatusCountRange(groupId);
      const counts = await tn.snapshot().getRangeAll(r.begin, r.end);
      const out: Record<NuQJobStatusCompat, number> = {
        queued: 0,
        active: 0,
        completed: 0,
        failed: 0,
        backlog: 0,
      };
      for (const [key, value] of counts) {
        const status = ks.unpackId(key as Buffer);
        const n = Math.max(0, decodeI64(value as Buffer));
        if (status === "pending") out.backlog += n;
        else if (status in out) out[status as NuQJobStatusCompat] += n;
      }
      return out;
    });
  }

  public async getGroupAnyJob(
    groupId: string,
    ownerId: string,
    logger: Logger = _logger,
  ): Promise<NuQFdbJob<JobData, JobReturnValue> | null> {
    const ks = this.ks;
    const owner = normalizeOwnerId(ownerId);
    const candidateId = await this.db.doTn(async tn => {
      const r = ks.groupJobRange(groupId);
      let begin: Buffer | FdbKeySelector = r.begin;
      // scan for the first countable (single_urls) member
      for (let scanned = 0; scanned < 2000; ) {
        const batch = await tn
          .snapshot()
          .getRangeAll(begin as any, r.end, { limit: 200 });
        if (batch.length === 0) return null;
        for (const [key, value] of batch) {
          const gj = decodeJson<GroupJobIndexValue>(value as Buffer);
          if (gj?.m === 1) return ks.unpackId(key as Buffer);
        }
        scanned += batch.length;
        const lastKey = batch[batch.length - 1][0] as Buffer;
        begin = {
          key: lastKey,
          orEqual: true,
          offset: 1,
          _isKeySelector: true,
        };
      }
      return null;
    });
    if (!candidateId) return null;
    const job = await this.getJob(candidateId, logger);
    if (!job) return null;
    if (owner !== null && job.ownerId !== owner) return null;
    return job;
  }

  public async getCrawlJobsForListing(
    groupId: string,
    limit: number,
    offset: number,
    logger: Logger = _logger,
  ): Promise<NuQFdbJob<JobData, JobReturnValue>[]> {
    const ks = this.ks;
    const ids = await this.db.doTn(async tn => {
      const r = ks.groupDoneRange(groupId);
      const rows = await tn
        .snapshot()
        .getRangeAll(r.begin, r.end, { limit: offset + limit });
      return rows
        .slice(offset)
        .map(([, value]) => (value as Buffer).toString("utf8"));
    });
    const jobs = await this.getJobs(ids, logger);
    const byId = new Map(jobs.map(j => [j.id, j]));
    return ids
      .map(id => byId.get(id))
      .filter(
        (j): j is NuQFdbJob<JobData, JobReturnValue> =>
          !!j && j.status === "completed",
      );
  }

  // === Introspection used by status/admin endpoints

  public async getTeamActiveCount(teamId: string): Promise<number> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return 0;
    return await this.db.doTn(async tn =>
      Math.max(
        0,
        decodeI64(await tn.snapshot().get(this.ks.teamActive(owner))),
      ),
    );
  }

  public async getTeamActiveCounts(): Promise<Map<string, number>> {
    const ks = this.ks;
    return await this.db.doTn(async tn => {
      const r = ks.teamActiveIndexRange();
      const rows = await tn.snapshot().getRangeAll(r.begin, r.end);
      const counts = new Map<string, number>();
      for (const [key, value] of rows) {
        const parts = ks.unpack(key as Buffer);
        const teamId = parts[2];
        if (typeof teamId !== "string") continue;
        const count = Math.max(0, decodeI64(value as Buffer));
        if (count > 0) counts.set(teamId, count);
      }
      return counts;
    });
  }

  public async getTeamPendingCount(teamId: string): Promise<number> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return 0;
    return await this.db.doTn(async tn =>
      Math.max(
        0,
        decodeI64(await tn.snapshot().get(this.ks.teamPendingCount(owner))),
      ),
    );
  }
}

class LockLostError extends Error {}
