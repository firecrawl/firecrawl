import { createHash, randomUUID } from "crypto";
import type {
  Transaction,
  TransactionOptionCode as FdbTransactionOptionCode,
} from "foundationdb";
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
  METRIC_SHARDS,
  METRIC_STATUSES,
  NuqFdbMetricControl,
  NuqFdbMetricStatus,
  F_GATED,
  F_CRAWL_GATED,
  F_LISTENABLE,
  F_ZDR,
  F_COUNTABLE,
  F_GACC,
  F_KEY_GATED,
  normalizeOwnerId,
  IngestMeta,
  ClaimRecord,
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
  appendKeyPending,
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
  alignQueueMetricStatus,
  GroupJobIndexValue,
} from "./ops";
import { NuqFdbGroupOps } from "./groups";

// FDB's stable transaction option code for TIMEOUT. Keep this local so merely
// importing queue types does not eagerly load libfdb_c in PG-only processes.
const TransactionOptionCode = {
  Timeout: 500 as FdbTransactionOptionCode,
  RetryLimit: 501 as FdbTransactionOptionCode,
  MaxRetryDelay: 502 as FdbTransactionOptionCode,
};

const DATA_CHUNK_BYTES = 90 * 1024;
// FoundationDB caps transactions at 10,000,000 bytes of affected data. Keep
// enqueue batches much smaller so large payloads cannot accidentally combine
// into a commit-time transaction_too_large failure.
const FDB_TRANSACTION_BYTE_LIMIT = 10_000_000;
const ENQUEUE_BATCH_BYTE_BUDGET = 750 * 1024;
const ENQUEUE_SINGLE_JOB_BYTE_LIMIT = 8 * 1024 * 1024;
const ENQUEUE_MAX_JOBS_PER_TRANSACTION = 250;
const MAX_INLINE_RETURNVALUE_BYTES = 8 * 1024 * 1024;
const MAX_FAILED_REASON_BYTES = 90 * 1024;
const INGEST_TTL_MS = 60 * 60 * 1000;
const CLAIM_CLEANUP_MAX_IN_FLIGHT = 8;
const CLAIM_CLEANUP_TIMEOUT_MS = 250;
const CLAIM_CLEANUP_RETRY_LIMIT = 1;
const CLAIM_CLEANUP_MAX_RETRY_DELAY_MS = 25;

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
  /** Intrinsic queue identity; direct FDB consumers must never run PG cleanup. */
  backend: "fdb";
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
  // API-key-scoped concurrency limit; null/absent = the key is unlimited.
  // Only applies when the batch is team-gated (teamLimit !== null).
  key?: { id: string; limit: number } | null;
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

type IngestJobPlan = {
  h: string;
  p: number;
  o: string;
  g?: string;
  b: boolean;
  l: boolean;
  to?: number;
  dc: number;
  ct: boolean;
  z: boolean;
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
  if (s === "ingesting" || s === "cancelled") return null;
  return s;
}

function truncateUtf8(value: string, maxBytes: number): Buffer {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

class IngestBusyError extends Error {}
class IngestValidationError extends Error {}
export class NuqFdbMetricsInitializingError extends Error {}

function encodedJsonBytes(v: any): number {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

function semanticDataHash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value ?? null, (key, nested) =>
        key === "traceContext" ? undefined : nested,
      ),
    )
    .digest("hex");
}

export class NuQFdbQueue<JobData = any, JobReturnValue = any> {
  public readonly ks: NuqFdbKeyspace;
  public readonly groupOps: NuqFdbGroupOps | null;
  private claimCleanupInFlight = 0;

  constructor(
    public readonly queueName: string,
    public readonly options: {
      // whether jobs in this queue participate in group (crawl) accounting
      hasGroups: boolean;
      // queue that group-finish jobs are emitted into (scrape -> crawl_finished)
      finishedQueueName?: string;
      // lease duration override, used by tests
      leaseMs?: number;
      // Deterministic fault/race injection for the FDB integration tests.
      testHooks?: {
        afterManifest?: () => Promise<void>;
        afterStageBatch?: (batch: number) => Promise<void>;
        afterPublishBatch?: (batch: number) => Promise<void>;
        simulateClaimCommitUnknown?: () => boolean;
        runClaimCleanup?: (cleanup: () => Promise<void>) => Promise<void>;
      };
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
    if (gate.teamLimit !== null && ownerId === null) {
      throw new Error("Team-gated jobs require an owner");
    }

    // Duplicate IDs in one call are one logical enqueue. Preserve the API's
    // output cardinality/order below while ensuring each ID is placed once.
    const byId = new Map<string, AddJobInput<JobData>>();
    for (const job of jobs) if (!byId.has(job.id)) byId.set(job.id, job);
    const uniqueInputs = [...byId.values()];
    const prepared = uniqueInputs.map(j =>
      this.prepareAddJob(j, ownerId, gate.key?.id ?? null),
    );

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
    }

    // The stable operation identity intentionally excludes regenerated request
    // fields (deadlines, trace context, changing limits). The first caller's
    // gate and per-job plan are persisted; retries attach to that plan.
    const op = createHash("sha256")
      .update(
        JSON.stringify([
          this.queueName,
          ownerId,
          uniqueInputs.map(job => job.id),
        ]),
      )
      .digest("hex");
    await this.initIngest(op, ownerId, gate);

    const batches: PreparedAddJob<JobData>[][] = [];
    let batch: PreparedAddJob<JobData>[] = [];
    let batchBytes = 0;
    for (const job of prepared) {
      if (
        batch.length > 0 &&
        (batchBytes + job.estimatedAffectedBytes > ENQUEUE_BATCH_BYTE_BUDGET ||
          batch.length >= ENQUEUE_MAX_JOBS_PER_TRANSACTION)
      ) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(job);
      batchBytes += job.estimatedAffectedBytes;
    }
    if (batch.length > 0) batches.push(batch);

    // Persist the complete small manifest before claiming any IDs. This
    // freezes deadlines/options across a process-level retry without putting
    // the unbounded manifest in one FDB transaction.
    for (const manifestBatch of batches) {
      await this.persistIngestPlanBatch(op, manifestBatch);
    }
    await this.options.testHooks?.afterManifest?.();
    try {
      for (let batchNumber = 0; batchNumber < batches.length; batchNumber++) {
        for (let attempt = 0; ; attempt++) {
          try {
            await this.reserveAndStageBatch(op, batches[batchNumber]);
            break;
          } catch (error) {
            if (!(error instanceof IngestBusyError) || attempt >= 100)
              throw error;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        await this.options.testHooks?.afterStageBatch?.(batchNumber + 1);
      }
    } catch (error) {
      if (
        error instanceof QueueFullError ||
        error instanceof IngestValidationError ||
        error instanceof IngestBusyError
      ) {
        await this.abortIngest(op);
      }
      throw error;
    }

    for (let i = 0; i < batches.length; i++) {
      await this.publishIngestBatch(op, batches[i]);
      await this.options.testHooks?.afterPublishBatch?.(i + 1);
    }
    await this.finalizeIngest(op);

    const stored = await this.getJobs(
      uniqueInputs.map(j => j.id),
      logger,
    );
    const storedById = new Map(stored.map(job => [job.id, job]));
    return jobs.map(j => {
      const storedJob = storedById.get(j.id);
      if (!storedJob) {
        throw new Error(`Job ${j.id} disappeared after enqueue publication`);
      }
      return storedJob;
    });
  }

  private prepareAddJob(
    job: AddJobInput<JobData>,
    ownerId: string | null,
    keyId: string | null,
  ): PreparedAddJob<JobData> {
    const dataBuf = Buffer.from(JSON.stringify(job.data ?? null), "utf8");
    const dataChunks = chunkBuffer(dataBuf, DATA_CHUNK_BYTES);
    const estimatedAffectedBytes = this.estimateEnqueueAffectedBytes(
      job,
      ownerId,
      keyId,
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
    keyId: string | null,
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
      k: keyId ?? undefined,
      p: priority,
      f:
        F_GATED |
        F_CRAWL_GATED |
        F_KEY_GATED |
        F_LISTENABLE |
        F_ZDR |
        F_COUNTABLE |
        F_GACC,
      c: now,
      to: job.options.timesOutAt?.getTime(),
    };
    const meta: JobMeta = {
      c: now,
      p: priority,
      o: owner,
      g: gid,
      k: entry.k,
      f: entry.f,
      to: entry.to,
      dc: dataChunks.length,
    };

    let bytes =
      ks.jobMeta(job.id).length +
      encodedJsonBytes(meta) +
      ks.jobStatus(job.id).length +
      encodedJsonBytes({ s: "pending", st: 0 }) +
      // One generation ledger row and two fixed-counter atomic mutations are
      // the worst-case metric transition footprint.
      ks.metricLedger("00000000-0000-0000-0000-000000000000", job.id).length +
      "completed".length +
      2 *
        (ks.metricCount(
          "00000000-0000-0000-0000-000000000000",
          "completed",
          METRIC_SHARDS - 1,
        ).length +
          8) +
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

    if (keyId) {
      bytes +=
        ks.keyLimit(keyId).length +
        8 +
        ks.keyActive(keyId).length +
        8 +
        ks.keyPendingCount(keyId).length +
        8 +
        ks.keyPendingKey(keyId, priority, now, job.id).length +
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

  private async initIngest(
    op: string,
    ownerId: string | null,
    gate: NuQFdbGate,
  ): Promise<void> {
    const ks = this.ks;
    await this.db.doTn(async tn => {
      if (await tn.get(ks.ingest(op))) return;
      // Even an ingest that only creates the untracked "ingesting" state must
      // conflict with activation/invalidation. Publication performs the actual
      // canonical ledger alignment.
      await tn.get(ks.metricControl());
      const createdAt = Date.now();
      const meta: IngestMeta = {
        o: ownerId ?? "",
        c: createdAt,
        x: createdAt + INGEST_TTL_MS,
        r: 0,
        l: gate.teamLimit,
        q: gate.queueCap,
        k: gate.key ?? null,
      };
      tn.set(ks.ingest(op), encodeJson(meta));
      tn.set(ks.ingestExpiry(meta.x, op), EMPTY);
    });
  }

  private async persistIngestPlanBatch(
    op: string,
    jobs: PreparedAddJob<JobData>[],
  ): Promise<void> {
    const ks = this.ks;
    await this.db.doTn(async tn => {
      const opMeta = decodeJson<IngestMeta>(await tn.get(ks.ingest(op)));
      if (!opMeta) return;
      const [existing, statuses] = await Promise.all([
        Promise.all(jobs.map(job => tn.get(ks.ingestJob(op, job.id)))),
        Promise.all(jobs.map(job => tn.get(ks.jobStatus(job.id)))),
      ]);
      for (let i = 0; i < jobs.length; i++) {
        // A published/existing status is authoritative. This normal read
        // conflicts with publication, so a concurrent retry cannot recreate
        // a manifest row after publish cleared it.
        if (existing[i] || statuses[i]) continue;
        const job = jobs[i];
        const plan: IngestJobPlan = {
          h: semanticDataHash(job.data),
          p: job.options.priority ?? 0,
          o: opMeta.o,
          g: job.options.groupId,
          b: !!job.options.bypassGate,
          l: !!job.options.listenable,
          to: job.options.timesOutAt?.getTime(),
          dc: job.dataChunks.length,
          ct: (job.data as any)?.mode === "single_urls",
          z: !!(job.data as any)?.zeroDataRetention,
        };
        tn.set(ks.ingestJob(op, job.id), encodeJson(plan));
      }
    });
  }

  private async reserveAndStageBatch(
    op: string,
    jobs: PreparedAddJob<JobData>[],
  ): Promise<void> {
    const ks = this.ks;
    await this.db.doTn(async tn => {
      const opMeta = decodeJson<IngestMeta>(await tn.get(ks.ingest(op)));
      if (!opMeta) return;
      const [statuses, planValues] = await Promise.all([
        Promise.all(jobs.map(job => tn.get(ks.jobStatus(job.id)))),
        Promise.all(jobs.map(job => tn.get(ks.ingestJob(op, job.id)))),
      ]);
      const fresh: { job: PreparedAddJob<JobData>; plan: IngestJobPlan }[] = [];
      for (let i = 0; i < jobs.length; i++) {
        const status = decodeJson<JobStatusRecord>(statuses[i]);
        const plan = decodeJson<IngestJobPlan>(planValues[i]);
        if (!plan) continue;
        if (status?.s === "ingesting" && status.op !== op) {
          throw new IngestBusyError(`Job ${jobs[i].id} is being ingested`);
        }
        if (status?.s === "cancelled") {
          throw new IngestValidationError(
            `Job ${jobs[i].id} was cancelled and is not reusable yet`,
          );
        }
        if (!status) {
          if (semanticDataHash(jobs[i].data) !== plan.h) {
            throw new IngestValidationError(
              `Job ${jobs[i].id} changed during ingest retry`,
            );
          }
          fresh.push({ job: jobs[i], plan });
        } else if (status.s !== "ingesting") {
          tn.clear(ks.ingestJob(op, jobs[i].id));
        }
      }
      if (fresh.length === 0) return;

      const gated = fresh.filter(
        ({ plan }) => opMeta.l !== null && !plan.b,
      ).length;
      if (gated > 0 && opMeta.o) {
        const [pendingBuf, reservedBuf] = await Promise.all([
          tn.get(ks.teamPendingCount(opMeta.o)),
          tn.get(ks.teamIngestReserved(opMeta.o)),
        ]);
        const pending = decodeI64(pendingBuf);
        const reserved = decodeI64(reservedBuf);
        if (pending + reserved + gated > opMeta.q) {
          throw new QueueFullError(pending + reserved, opMeta.q);
        }
        tn.add(ks.teamIngestReserved(opMeta.o), encodeI64(gated));
        const storedBuf = await tn.get(ks.teamLimit(opMeta.o));
        const stored = storedBuf ? decodeI64(storedBuf) : null;
        if (stored !== opMeta.l) {
          tn.set(ks.teamLimit(opMeta.o), encodeI64(opMeta.l!));
          if (stored !== null && opMeta.l! > stored) {
            tn.set(ks.taskTeamRaise(opMeta.o), EMPTY);
          }
        }
      }

      if (this.options.hasGroups) {
        for (const gid of new Set(fresh.map(({ plan }) => plan.g))) {
          if (!gid || (await tn.get(ks.ingestGroup(op, gid)))) continue;
          const groupMeta = decodeJson<GroupMeta>(
            await tn.get(ks.groupMeta(gid)),
          );
          if (groupMeta?.s !== "active") {
            throw new IngestValidationError(
              `Cannot enqueue job into non-active group ${gid}`,
            );
          }
          tn.set(ks.ingestGroup(op, gid), EMPTY);
          tn.add(ks.groupIngestCount(gid), ONE);
        }
      }

      tn.set(ks.ingest(op), encodeJson({ ...opMeta, r: opMeta.r + gated }));
      for (const { job } of fresh) {
        tn.set(
          ks.jobStatus(job.id),
          encodeJson({ s: "ingesting", st: 0, op } satisfies JobStatusRecord),
        );
        job.dataChunks.forEach((chunk, chunkIndex) =>
          tn.set(ks.jobData(job.id, chunkIndex), chunk),
        );
        await alignQueueMetricStatus(tn, ks, job.id);
      }
    });
  }

  private async publishIngestBatch(
    op: string,
    jobs: PreparedAddJob<JobData>[],
  ): Promise<void> {
    const ks = this.ks;
    await this.db.doTn(async tn => {
      const txc = newTxContext();
      const now = Date.now();
      const opMeta = decodeJson<IngestMeta>(await tn.get(ks.ingest(op)));
      if (!opMeta) return;
      const [statuses, planValues] = await Promise.all([
        Promise.all(jobs.map(job => tn.get(ks.jobStatus(job.id)))),
        Promise.all(jobs.map(job => tn.get(ks.ingestJob(op, job.id)))),
      ]);
      const publishJobs = jobs.flatMap((job, i) => {
        const status = decodeJson<JobStatusRecord>(statuses[i]);
        const plan = decodeJson<IngestJobPlan>(planValues[i]);
        if (status?.s !== "ingesting" || status.op !== op || !plan) return [];
        return [
          {
            ...job,
            data: {
              mode: plan.ct ? "single_urls" : undefined,
              zeroDataRetention: plan.z,
            } as JobData,
            dataChunks: new Array<Buffer>(plan.dc),
            options: {
              ownerId: plan.o || undefined,
              groupId: plan.g,
              priority: plan.p,
              bypassGate: plan.b,
              listenable: plan.l,
              timesOutAt: plan.to === undefined ? undefined : new Date(plan.to),
            },
          },
        ];
      });
      if (publishJobs.length === 0) return;
      const ownerId = opMeta.o || null;
      const gate: NuQFdbGate = {
        teamLimit: opMeta.l,
        queueCap: opMeta.q,
        key: opMeta.k,
      };

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

        // Strict for every limit, including >=256. The ingest reservation
        // bounds queue admission; this conflicting read bounds active slots.
        const active = decodeI64(await tn.get(ks.teamActive(ownerId)));
        free = Math.max(0, gate.teamLimit - active);
      }

      // API-key gate state; only meaningful inside the team-gated world
      let keyFree = Infinity;
      const keyId = gate.teamLimit !== null && gate.key ? gate.key.id : null;
      if (keyId !== null && gate.key) {
        const storedBuf = await tn.get(ks.keyLimit(keyId));
        const stored = storedBuf ? decodeI64(storedBuf) : null;
        if (stored !== gate.key.limit) {
          tn.set(ks.keyLimit(keyId), encodeI64(gate.key.limit));
          if (stored !== null && gate.key.limit > stored) {
            tn.set(ks.taskKeyRaise(keyId), EMPTY);
          }
        }
        // key limits are small by definition: always the strict read
        const kActive = decodeI64(await tn.get(ks.keyActive(keyId)));
        keyFree = Math.max(0, gate.key.limit - kActive);
      }

      // crawl gate state per distinct live group
      const groupMetas = new Map<string, GroupMeta | null>();
      const crawlFree = new Map<string, number>();
      if (this.options.hasGroups) {
        for (const j of publishJobs) {
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
      let keyGranted = 0;
      const crawlAcquired = new Map<string, number>();

      for (const j of publishJobs) {
        const gid = j.options.groupId;
        const gMeta = gid ? groupMetas.get(gid) : null;
        const groupAccounted = !!gMeta && !!gid && gMeta.s !== "completed";
        const gated = gate.teamLimit !== null && !j.options.bypassGate;
        const crawlGated =
          gated && !!gid && gMeta?.s === "active" && crawlFree.has(gid!);
        const keyGated = gated && keyId !== null;
        const countable =
          this.options.hasGroups &&
          groupAccounted &&
          (j.data as any)?.mode === "single_urls";

        let flags = 0;
        if (gated) flags |= F_GATED;
        if (crawlGated) flags |= F_CRAWL_GATED;
        if (keyGated) flags |= F_KEY_GATED;
        if (j.options.listenable) flags |= F_LISTENABLE;
        if ((j.data as any)?.zeroDataRetention) flags |= F_ZDR;
        if (countable) flags |= F_COUNTABLE;
        if (groupAccounted) flags |= F_GACC;

        const timesOutAt = gated ? j.options.timesOutAt?.getTime() : undefined;
        const entry: QueueEntry = {
          i: j.id,
          o: ownerId ?? "",
          g: gid,
          k: keyGated ? keyId! : undefined,
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
          k: entry.k,
          f: flags,
          to: timesOutAt,
          dc: j.dataChunks.length,
        };
        tn.set(ks.jobMeta(j.id), encodeJson(meta));

        let placedStatus: NuqFdbJobStatus;
        if (!gated) {
          pushReady(tn, ks, entry, txc);
          setStatusQueued(tn, ks, j.id);
          placedStatus = "queued";
        } else if (crawlGated && crawlFree.get(gid!)! <= 0) {
          const loc = appendCrawlPending(tn, ks, entry);
          setStatusPending(tn, ks, j.id, loc);
          placedStatus = "pending";
        } else if (keyGated && keyFree <= 0) {
          // holds the crawl slot (if any) while waiting in the key gate
          if (crawlGated) {
            crawlFree.set(gid!, crawlFree.get(gid!)! - 1);
            crawlAcquired.set(gid!, (crawlAcquired.get(gid!) ?? 0) + 1);
          }
          const loc = appendKeyPending(tn, ks, entry);
          setStatusPending(tn, ks, j.id, loc);
          placedStatus = "pending";
        } else {
          if (crawlGated) {
            crawlFree.set(gid!, crawlFree.get(gid!)! - 1);
            crawlAcquired.set(gid!, (crawlAcquired.get(gid!) ?? 0) + 1);
          }
          if (keyGated) {
            keyFree--;
            keyGranted++;
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

        await alignQueueMetricStatus(tn, ks, j.id);
        if (groupAccounted && gid) {
          tn.add(ks.groupRemaining(gid), ONE);
          setGroupJobIndex(tn, ks, gid, j.id, countable, placedStatus);
          if (countable) bumpGroupStatusCount(tn, ks, gid, placedStatus, 1);
          if (gMeta?.s === "cancelled") {
            tn.set(ks.taskGroupCancel(gid), EMPTY);
          }
        }
        tn.clear(ks.ingestJob(op, j.id));
      }

      if (granted > 0 && ownerId !== null) {
        bumpTeamActive(tn, ks, ownerId, granted);
      }
      if (keyGranted > 0 && keyId !== null) {
        tn.add(ks.keyActive(keyId), encodeI64(keyGranted));
      }
      for (const [gid, n] of crawlAcquired) {
        tn.add(ks.groupCrawlActive(gid), encodeI64(n));
      }

      const releasedReservations = publishJobs.filter(
        job => gate.teamLimit !== null && !job.options.bypassGate,
      ).length;
      if (releasedReservations > 0 && ownerId !== null) {
        tn.add(
          ks.teamIngestReserved(ownerId),
          encodeI64(-releasedReservations),
        );
      }
      tn.set(
        ks.ingest(op),
        encodeJson({
          ...opMeta,
          r: Math.max(0, opMeta.r - releasedReservations),
        } satisfies IngestMeta),
      );
    });
  }

  private async abortIngest(op: string): Promise<void> {
    const ks = this.ks;
    for (;;) {
      const done = await this.db.doTn(async tn => {
        const opMeta = decodeJson<IngestMeta>(await tn.get(ks.ingest(op)));
        if (!opMeta) return true;
        const jobsRange = ks.ingestJobRange(op);
        const jobs = await tn.getRangeAll(jobsRange.begin, jobsRange.end, {
          limit: 200,
        });
        for (const [jobKey] of jobs) {
          const id = ks.unpackId(jobKey as Buffer);
          const status = decodeJson<JobStatusRecord>(
            await tn.get(ks.jobStatus(id)),
          );
          if (status?.s === "ingesting" && status.op === op) {
            deleteJobRecords(tn, ks, id);
            await alignQueueMetricStatus(tn, ks, id);
          }
          tn.clear(jobKey as Buffer);
        }
        if (jobs.length > 0) return false;
        const groupsRange = ks.ingestGroupRange(op);
        const groups = await tn.getRangeAll(
          groupsRange.begin,
          groupsRange.end,
          { limit: 200 },
        );
        for (const [groupKey] of groups) {
          const gid = ks.unpackId(groupKey as Buffer);
          tn.clear(groupKey as Buffer);
          tn.add(ks.groupIngestCount(gid), MINUS_ONE);
          tn.set(ks.taskGroupFinish(gid), EMPTY);
        }
        if (groups.length > 0) return false;
        if (opMeta.r > 0 && opMeta.o) {
          tn.add(ks.teamIngestReserved(opMeta.o), encodeI64(-opMeta.r));
        }
        tn.clear(ks.ingestExpiry(opMeta.x, op));
        tn.clear(ks.ingest(op));
        return true;
      });
      if (done) return;
    }
  }

  private async finalizeIngest(op: string): Promise<void> {
    const ks = this.ks;
    for (let attempt = 0; ; attempt++) {
      const state = await this.db.doTn(async tn => {
        const opMeta = decodeJson<IngestMeta>(await tn.get(ks.ingest(op)));
        if (!opMeta) return "done" as const;
        const jobsRange = ks.ingestJobRange(op);
        // This must be a conflicting range read: a concurrent persister may
        // not insert a manifest after we decide the operation is empty.
        const remainingJobs = await tn.getRangeAll(
          jobsRange.begin,
          jobsRange.end,
          { limit: 200 },
        );
        if (remainingJobs.length > 0) {
          let waiting = false;
          for (const [jobKey] of remainingJobs) {
            const id = ks.unpackId(jobKey as Buffer);
            const status = decodeJson<JobStatusRecord>(
              await tn.get(ks.jobStatus(id)),
            );
            if (status?.s === "ingesting" && status.op === op) {
              waiting = true;
            } else {
              // Defensive cleanup for a retry that stopped after persisting a
              // plan for an already-existing job.
              tn.clear(jobKey as Buffer);
            }
          }
          return waiting ? ("waiting" as const) : ("progress" as const);
        }
        const groupRange = ks.ingestGroupRange(op);
        const groups = await tn.getRangeAll(groupRange.begin, groupRange.end, {
          limit: 200,
        });
        for (const [groupKey] of groups) {
          const gid = ks.unpackId(groupKey as Buffer);
          tn.clear(groupKey as Buffer);
          tn.add(ks.groupIngestCount(gid), MINUS_ONE);
          tn.set(ks.taskGroupFinish(gid), EMPTY);
        }
        if (groups.length > 0) return "progress" as const;
        if (opMeta.r > 0 && opMeta.o) {
          tn.add(ks.teamIngestReserved(opMeta.o), encodeI64(-opMeta.r));
        }
        tn.clear(ks.ingestExpiry(opMeta.x, op));
        tn.clear(ks.ingest(op));
        return "done" as const;
      });
      if (state === "done") return;
      if (state === "waiting") {
        if (attempt >= 100) {
          throw new IngestBusyError(`Ingest ${op} is still being published`);
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }

  // === Take (worker dequeue)

  public async getJobToProcess(
    logger: Logger = _logger,
    operation?: { timeoutMs: number },
  ): Promise<NuQFdbJob<JobData, JobReturnValue> | null> {
    const startedAt = Date.now();
    const operationDeadline = operation
      ? startedAt + operation.timeoutMs
      : null;
    const remainingOperation = () => {
      if (operationDeadline === null) return undefined;
      const timeoutMs = operationDeadline - Date.now();
      if (timeoutMs <= 0) {
        throw new Error("FDB dequeue operation timed out");
      }
      return { timeoutMs };
    };
    // blind random probes win at high occupancy (no coordination, conflicts
    // spread across shards); the occupancy scan below covers the sparse case
    const PROBES = Math.min(4, READY_SHARDS);
    const tried = new Set<number>();
    let randomDropped = 0;
    while (tried.size < PROBES) {
      const shard = Math.floor(Math.random() * READY_SHARDS);
      if (tried.has(shard)) continue;
      const result = await this.takeFromShard(shard, remainingOperation());
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
    const candidatesOperation = remainingOperation();
    const candidates = await this.db.doTn(async tn => {
      if (candidatesOperation) {
        tn.setOption(
          TransactionOptionCode.Timeout,
          candidatesOperation.timeoutMs,
        );
      }
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
        const result = await this.takeFromShard(shard, remainingOperation());
        if (result === "empty") {
          fallbackEmpty++;
          break;
        }
        if (result === "dropped") {
          fallbackDropped++;
          continue;
        }
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
    operation?: { timeoutMs: number },
  ): Promise<NuQFdbJob<JobData, JobReturnValue> | "empty" | "dropped"> {
    const ks = this.ks;
    const op = randomUUID();
    const claimTransaction = async (
      tn: Transaction,
    ): Promise<NuQFdbJob<JobData, JobReturnValue> | "empty" | "dropped"> => {
      if (operation)
        tn.setOption(TransactionOptionCode.Timeout, operation.timeoutMs);
      const prior = decodeJson<ClaimRecord>(await tn.get(ks.claim(op)));
      if (prior) return await this.readClaimedJob(tn, prior);
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
        // Tombstone (removed job) -- slots were released by the remover. The
        // placement GC still participates in the metric control protocol.
        await alignQueueMetricStatus(tn, ks, e.i);
        return "dropped";
      }

      if (e.g && this.options.hasGroups) {
        const gMeta = decodeJson<GroupMeta>(await tn.get(ks.groupMeta(e.g)));
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
          await alignQueueMetricStatus(tn, ks, e.i);
          await releaseSlotsAndPromote(
            tn,
            ks,
            e,
            { team: true, key: true, crawl: true },
            now,
            txc,
          );
          return "dropped";
        }
      }

      const meta = decodeJson<JobMeta>(
        await tn.snapshot().get(ks.jobMeta(e.i)),
      );
      if (!meta) {
        await alignQueueMetricStatus(tn, ks, e.i);
        return "dropped";
      }
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
      tn.set(
        ks.claim(op),
        encodeJson({ i: e.i, l: lock, e: exp } satisfies ClaimRecord),
      );
      tn.set(ks.claimExpiry(exp, op), EMPTY);
      await alignQueueMetricStatus(tn, ks, e.i);
      if (e.g && e.f & F_COUNTABLE) {
        bumpGroupStatusCount(tn, ks, e.g, "queued", -1);
        bumpGroupStatusCount(tn, ks, e.g, "active", 1);
        setGroupJobIndex(tn, ks, e.g, e.i, true, "active");
      }

      return {
        backend: "fdb" as const,
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
    };
    let result = await this.db.doTn(claimTransaction);
    if (this.options.testHooks?.simulateClaimCommitUnknown?.()) {
      // Model the binding retrying our closure after the first commit became
      // ambiguous. The operation marker must return the original claim.
      result = await this.db.doTn(claimTransaction);
    }
    // A definite result may return immediately. Marker cleanup is best-effort,
    // bounded per queue, and has no wait queue; durable claimExpiry is the
    // fallback whenever the cap, timeout, error, or process exit wins.
    if (result !== "empty" && result !== "dropped") {
      this.scheduleClaimCleanup(op);
    }
    return result;
  }

  private scheduleClaimCleanup(op: string): void {
    if (this.claimCleanupInFlight >= CLAIM_CLEANUP_MAX_IN_FLIGHT) return;
    this.claimCleanupInFlight++;
    const cleanup = async () => {
      await this.db.doTn(async tn => {
        tn.setOption(TransactionOptionCode.Timeout, CLAIM_CLEANUP_TIMEOUT_MS);
        tn.setOption(
          TransactionOptionCode.RetryLimit,
          CLAIM_CLEANUP_RETRY_LIMIT,
        );
        tn.setOption(
          TransactionOptionCode.MaxRetryDelay,
          CLAIM_CLEANUP_MAX_RETRY_DELAY_MS,
        );
        const marker = decodeJson<ClaimRecord>(await tn.get(this.ks.claim(op)));
        if (marker) tn.clear(this.ks.claimExpiry(marker.e, op));
        tn.clear(this.ks.claim(op));
      });
    };
    const run = this.options.testHooks?.runClaimCleanup;
    void (run ? run(cleanup) : cleanup())
      .catch(error => {
        _logger.debug("NuQ FDB claim cleanup deferred to sweeper", {
          canonicalLog: "nuq-fdb/claim_cleanup_deferred",
          queueName: this.queueName,
          error,
        });
      })
      .finally(() => {
        this.claimCleanupInFlight--;
      });
  }

  public getClaimCleanupInFlightForTest(): number {
    return this.claimCleanupInFlight;
  }

  private async readClaimedJob(
    tn: Transaction,
    claim: ClaimRecord,
  ): Promise<NuQFdbJob<JobData, JobReturnValue> | "dropped"> {
    const meta = decodeJson<JobMeta>(await tn.get(this.ks.jobMeta(claim.i)));
    const status = decodeJson<JobStatusRecord>(
      await tn.get(this.ks.jobStatus(claim.i)),
    );
    if (!meta || status?.s !== "active" || status.l !== claim.l) {
      return "dropped";
    }
    const range = this.ks.jobDataRange(claim.i);
    const parts = await tn.getRangeAll(range.begin, range.end);
    const data = JSON.parse(
      Buffer.concat(parts.map(([, value]) => value as Buffer)).toString("utf8"),
    );
    return {
      backend: "fdb",
      id: claim.i,
      status: "active",
      createdAt: new Date(meta.c),
      priority: meta.p,
      data,
      lock: claim.l,
      leaseExpiresAt: new Date(claim.e),
      ownerId: meta.o || undefined,
      groupId: meta.g,
    };
  }

  // === Leases

  public async renewLock(
    id: string,
    lock: string,
    logger: Logger = _logger,
    operation?: { timeoutMs: number },
  ): Promise<boolean> {
    const ks = this.ks;
    // Stable across a commit_unknown_result retry of this renewal.
    const newExp = Date.now() + (this.options.leaseMs ?? LEASE_MS);
    return await this.db.doTn(async tn => {
      if (operation)
        tn.setOption(TransactionOptionCode.Timeout, operation.timeoutMs);
      // A normal status read makes renew conflict with finish, cancellation and
      // reap. The status' lock/expiry, not worker-local memory, is authoritative.
      const st = decodeJson<JobStatusRecord>(await tn.get(ks.jobStatus(id)));
      if (!st || st.s !== "active" || st.l !== lock) return false;
      if (st.e !== undefined) {
        tn.clear(ks.lease(timeBucket(id), st.e, id));
      }
      const effectiveExp = Math.max(newExp, st.e ?? 0);
      tn.set(
        ks.lease(timeBucket(id), effectiveExp, id),
        encodeJson({ l: lock }),
      );
      tn.set(ks.jobStatus(id), encodeJson({ ...st, e: effectiveExp }));
      await alignQueueMetricStatus(tn, ks, id);
      return true;
    });
  }

  // === Finish / fail

  public async jobFinish(
    id: string,
    lock: string,
    returnvalue: JobReturnValue | null,
    logger: Logger = _logger,
    operation?: { timeoutMs: number },
  ): Promise<boolean> {
    return this.finishOrFail(
      id,
      lock,
      "completed",
      returnvalue ?? null,
      null,
      operation,
    );
  }

  public async jobFail(
    id: string,
    lock: string,
    failedReason: string,
    logger: Logger = _logger,
    operation?: { timeoutMs: number },
  ): Promise<boolean> {
    return this.finishOrFail(id, lock, "failed", null, failedReason, operation);
  }

  private async finishOrFail(
    id: string,
    lock: string,
    outcome: "completed" | "failed",
    returnvalue: any,
    failedReason: string | null,
    operation?: { timeoutMs: number },
  ): Promise<boolean> {
    const ks = this.ks;
    const ok = await this.db.doTn(async tn => {
      if (operation)
        tn.setOption(TransactionOptionCode.Timeout, operation.timeoutMs);
      const txc = newTxContext();
      const now = Date.now();
      const st = decodeJson<JobStatusRecord>(await tn.get(ks.jobStatus(id)));
      if (!st) {
        await alignQueueMetricStatus(tn, ks, id);
        return false;
      }
      // idempotency: a commit_unknown_result retry lands here
      if (st.s === outcome && st.l === lock) {
        await alignQueueMetricStatus(tn, ks, id);
        return true;
      }
      if (st.s !== "active" || st.l !== lock) return false;
      const meta = decodeJson<JobMeta>(await tn.get(ks.jobMeta(id)));
      if (!meta) {
        await alignQueueMetricStatus(tn, ks, id);
        return false;
      }

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
          if (buf.length <= MAX_INLINE_RETURNVALUE_BYTES) {
            chunkBuffer(buf, DATA_CHUNK_BYTES).forEach((chunk, ci) =>
              tn.set(ks.jobReturnvalue(id, ci), chunk),
            );
          }
        }
      } else {
        tn.set(
          ks.jobFailedReason(id),
          truncateUtf8(failedReason ?? "", MAX_FAILED_REASON_BYTES),
        );
      }

      await alignQueueMetricStatus(tn, ks, id);

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
        { team: true, key: true, crawl: true },
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
      backend: "fdb",
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
    // A job may contain ~8MiB input and ~8MiB inline output. Keep each job in
    // its own transaction, with bounded parallelism, rather than materializing
    // up to 100 giant jobs under one read version/heap burst.
    const CONCURRENCY = 16;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const jobs = await Promise.all(
        ids
          .slice(i, i + CONCURRENCY)
          .map(id => this.db.doTn(async tn => this.readJob(tn, id))),
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
      if (!st || st.s === "cancelled") {
        await alignQueueMetricStatus(tn, ks, id);
        return false;
      }
      const meta = decodeJson<JobMeta>(await tn.get(ks.jobMeta(id)));
      if (!meta) {
        await alignQueueMetricStatus(tn, ks, id);
        return false;
      }
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
      const countable = !!(meta.f & F_COUNTABLE);
      const accounted = !!(meta.f & F_GACC) && !!meta.g && !!this.groupOps;

      if (st.s === "pending") {
        clearPendingPlacement(
          tn,
          ks,
          id,
          meta.o,
          meta.g,
          meta.k,
          st.loc!,
          meta.to,
        );
        // key-pending and delayed jobs hold a crawl slot; team-pending jobs
        // hold a key slot on top
        if (st.loc!.k !== "gq") {
          await releaseSlotsAndPromote(
            tn,
            ks,
            entry,
            { team: false, key: st.loc!.k === "tq", crawl: true },
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
        await alignQueueMetricStatus(tn, ks, id);
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
          { team: true, key: true, crawl: true },
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
        await alignQueueMetricStatus(tn, ks, id);
      } else {
        // terminal: drop the records, like the PG row delete
        if (accounted) {
          tn.clear(ks.groupJob(meta.g!, id));
          if (countable) bumpGroupStatusCount(tn, ks, meta.g!, st.s, -1);
        }
        deleteJobRecords(tn, ks, id);
        await alignQueueMetricStatus(tn, ks, id);
      }
      return true;
    });
  }

  public async removeJobs(
    ids: string[],
    logger: Logger = _logger,
  ): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    const CONCURRENCY = 16;
    for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
      await Promise.all(
        uniqueIds
          .slice(i, i + CONCURRENCY)
          .map(id => this.removeJob(id, logger)),
      );
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
    const range = ks.groupJobRange(groupId);
    let begin: Buffer | FdbKeySelector = range.begin;
    // Page across transactions so a deep group cannot hit FDB's five-second
    // transaction lifetime or silently stop after an arbitrary member count.
    while (true) {
      const page = await this.db.doTn(async tn =>
        tn.snapshot().getRangeAll(begin as any, range.end, { limit: 200 }),
      );
      if (page.length === 0) return null;
      for (const [key, value] of page) {
        const gj = decodeJson<GroupJobIndexValue>(value as Buffer);
        if (gj?.m !== 1) continue;
        const job = await this.getJob(ks.unpackId(key as Buffer), logger);
        if (!job) continue;
        if (owner !== null && job.ownerId !== owner) return null;
        return job;
      }
      const lastKey = page[page.length - 1][0] as Buffer;
      begin = {
        key: lastKey,
        orEqual: true,
        offset: 1,
        _isKeySelector: true,
      };
    }
  }

  public async getCrawlJobsForListing(
    groupId: string,
    limit: number,
    offset: number,
    logger: Logger = _logger,
  ): Promise<NuQFdbJob<JobData, JobReturnValue>[]> {
    const ks = this.ks;
    const range = ks.groupDoneRange(groupId);
    const ids: string[] = [];
    let begin: Buffer | FdbKeySelector = range.begin;
    let skipped = 0;
    while (ids.length < limit) {
      const pageSize = Math.min(500, offset - skipped + (limit - ids.length));
      const rows = await this.db.doTn(async tn =>
        tn.snapshot().getRangeAll(begin as any, range.end, {
          limit: Math.max(1, pageSize),
        }),
      );
      if (rows.length === 0) break;
      for (const [, value] of rows) {
        if (skipped < offset) skipped++;
        else if (ids.length < limit)
          ids.push((value as Buffer).toString("utf8"));
      }
      const lastKey = rows[rows.length - 1][0] as Buffer;
      begin = {
        key: lastKey,
        orEqual: true,
        offset: 1,
        _isKeySelector: true,
      };
    }
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
    const range = ks.teamActiveIndexRange();
    const counts = new Map<string, number>();
    let begin: Buffer | FdbKeySelector = range.begin;
    while (true) {
      const page = await this.db.doTn(async tn => {
        const rows = await tn.getRangeAll(begin as any, range.end, {
          limit: 500,
        });
        const values: Array<[string, number]> = [];
        for (const [key] of rows) {
          const parts = ks.unpack(key as Buffer);
          const teamId = parts[3];
          if (typeof teamId !== "string") continue;
          const count = Math.max(
            0,
            decodeI64(await tn.get(ks.teamActive(teamId))),
          );
          if (count > 0) values.push([teamId, count]);
          else tn.clear(key as Buffer); // clean legacy zero-valued index rows
        }
        return { rows, values };
      });
      for (const [teamId, count] of page.values) counts.set(teamId, count);
      if (page.rows.length < 500) break;
      const lastKey = page.rows[page.rows.length - 1][0] as Buffer;
      begin = {
        key: lastKey,
        orEqual: true,
        offset: 1,
        _isKeySelector: true,
      };
    }
    return counts;
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

  private decodeMetricControl(
    value: Buffer | undefined | null,
  ): NuqFdbMetricControl | null {
    const control = decodeJson<NuqFdbMetricControl>(value);
    if (!control) return null;
    if (
      control.format !== 3 ||
      control.shards !== METRIC_SHARDS ||
      !control.generation ||
      !["backfill-jobs", "backfill-ledger", "ready"].includes(control.phase)
    ) {
      throw new Error("Unsupported NuQ FDB metric control record");
    }
    return control;
  }

  // Explicit release-B activation API. Concurrent callers converge on the one
  // generation that wins the normal control-key conflict.
  public async beginMetricCounterBackfill(): Promise<NuqFdbMetricControl> {
    const requested: NuqFdbMetricControl = {
      format: 3,
      generation: randomUUID(),
      phase: "backfill-jobs",
      shards: METRIC_SHARDS,
    };
    return await this.db.doTn(async tn => {
      const current = this.decodeMetricControl(
        await tn.get(this.ks.metricControl()),
      );
      if (current) return current;
      tn.set(this.ks.metricControl(), encodeJson(requested));
      return requested;
    });
  }

  public async getMetricCounterBackfillStatus(): Promise<NuqFdbMetricControl | null> {
    return await this.db.doTn(async tn =>
      this.decodeMetricControl(
        await tn.snapshot().get(this.ks.metricControl()),
      ),
    );
  }

  // Deployment rollback must call this before any pre-protocol writer returns.
  // Old generation keys intentionally remain isolated for later bounded GC.
  public async invalidateMetricCounterGeneration(
    expectedGeneration?: string,
  ): Promise<boolean> {
    return await this.db.doTn(async tn => {
      const control = this.decodeMetricControl(
        await tn.get(this.ks.metricControl()),
      );
      if (!control) return true;
      if (
        expectedGeneration !== undefined &&
        control.generation !== expectedGeneration
      ) {
        return false;
      }
      tn.clear(this.ks.metricControl());
      return true;
    });
  }

  // Advances one durable raw-key page. Job discovery intentionally scans every
  // legacy job key so status-only tombstones and jobs with very large payloads
  // are handled exactly. The second, separately enumerable ledger pass removes
  // orphans before READY. Cursor, all alignments, and phase change are atomic.
  public async backfillMetricCounts(
    batchSize = 100,
    activate = false,
  ): Promise<boolean> {
    if (activate) await this.beginMetricCounterBackfill();
    const pageSize = Math.max(1, batchSize);
    return await this.db.doTn(async tn => {
      const control = this.decodeMetricControl(
        await tn.get(this.ks.metricControl()),
      );
      if (!control) return false;
      if (control.phase === "ready") return true;

      if (control.phase === "backfill-jobs") {
        const range = this.ks.jobRootRange();
        const cursor = await tn.get(
          this.ks.metricJobsCursor(control.generation),
        );
        const begin = cursor
          ? Buffer.concat([cursor as Buffer, Buffer.from([0])])
          : range.begin;
        const rows = await tn.getRangeAll(begin, range.end, {
          limit: pageSize,
        });
        const ids = new Set<string>();
        for (const [key] of rows) {
          const parts = this.ks.unpack(key as Buffer);
          if (parts[2] === "j" && typeof parts[3] === "string") {
            ids.add(parts[3]);
          }
        }
        for (const id of ids) {
          await alignQueueMetricStatus(tn, this.ks, id);
        }
        if (rows.length < pageSize) {
          tn.clear(this.ks.metricJobsCursor(control.generation));
          tn.set(
            this.ks.metricControl(),
            encodeJson({ ...control, phase: "backfill-ledger" }),
          );
        } else {
          tn.set(
            this.ks.metricJobsCursor(control.generation),
            rows[rows.length - 1][0] as Buffer,
          );
        }
        return false;
      }

      const range = this.ks.metricLedgerRange(control.generation);
      const cursor = await tn.get(
        this.ks.metricLedgerCursor(control.generation),
      );
      const begin = cursor
        ? Buffer.concat([cursor as Buffer, Buffer.from([0])])
        : range.begin;
      const rows = await tn.getRangeAll(begin, range.end, {
        limit: pageSize,
      });
      for (const [key] of rows) {
        await alignQueueMetricStatus(
          tn,
          this.ks,
          this.ks.unpackId(key as Buffer),
        );
      }
      if (rows.length < pageSize) {
        tn.clear(this.ks.metricLedgerCursor(control.generation));
        tn.set(
          this.ks.metricControl(),
          encodeJson({ ...control, phase: "ready" }),
        );
        return true;
      }
      tn.set(
        this.ks.metricLedgerCursor(control.generation),
        rows[rows.length - 1][0] as Buffer,
      );
      return false;
    });
  }

  public async getWorkerLoadCount(): Promise<number> {
    const counts = await this.getMetricCounts();
    return counts.queued + counts.active;
  }

  private async getMetricCounts(): Promise<Record<NuQJobStatusCompat, number>> {
    const ks = this.ks;
    return await this.db.doTn(async tn => {
      const snapshot = tn.snapshot();
      // READY has one control read plus exactly 5x32 generation-scoped point
      // reads. No job, ledger, placement, lease, or team range is touched.
      const control = this.decodeMetricControl(
        await snapshot.get(ks.metricControl()),
      );
      if (!control || control.phase !== "ready") {
        throw new NuqFdbMetricsInitializingError(
          "NuQ FDB metrics are initializing",
        );
      }
      const rows = await Promise.all(
        METRIC_STATUSES.map(status =>
          Promise.all(
            Array.from({ length: METRIC_SHARDS }, (_, shard) =>
              snapshot.get(ks.metricCount(control.generation, status, shard)),
            ),
          ),
        ),
      );
      const totals = new Map<NuqFdbMetricStatus, number>();
      METRIC_STATUSES.forEach((status, index) => {
        const total = rows[index].reduce(
          (sum, value) => sum + decodeI64(value),
          0,
        );
        if (!Number.isSafeInteger(total) || total < 0) {
          throw new Error(`Corrupt NuQ FDB metric counter ${status}: ${total}`);
        }
        totals.set(status, total);
      });
      return {
        queued: totals.get("queued")!,
        active: totals.get("active")!,
        completed: totals.get("completed")!,
        failed: totals.get("failed")!,
        backlog: totals.get("pending")!,
      };
    });
  }

  public async getMetrics(): Promise<string> {
    const metricName = `nuq_fdb_queue_${this.queueName.replace(/[^a-zA-Z0-9_]/g, "_")}_job_count`;
    const statusCounts = await this.getMetricCounts();
    return `# HELP ${metricName} Number of FDB jobs in each status\n# TYPE ${metricName} gauge\n${(
      [
        "queued",
        "active",
        "completed",
        "failed",
        "backlog",
      ] satisfies NuQJobStatusCompat[]
    )
      .map(
        status => `${metricName}{status="${status}"} ${statusCounts[status]}`,
      )
      .join("\n")}\n`;
  }
}
