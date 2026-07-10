import { randomUUID } from "crypto";
import type { Transaction } from "foundationdb";
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
  RaiseTask,
  decodeI64,
  decodeJson,
  encodeI64,
  encodeJson,
  timeBucket,
  TIME_BUCKETS,
  F_CRAWL_GATED,
  F_COUNTABLE,
  F_GACC,
  F_KEY_GATED,
  IngestMeta,
} from "./keyspace";
import {
  MINUS_ONE,
  EMPTY,
  MAX_STALLS,
  COMPLETED_STANDALONE_RETENTION_MS,
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
  bumpGroupStatusCount,
  bumpTeamActive,
  bumpKeyActive,
  scheduleRaiseTask,
  setGroupJobIndex,
  GroupJobIndexValue,
  alignQueueMetricStatus,
} from "./ops";
import { ACTIVE_GROUP_MAX_AGE_MS } from "./groups";
import { NuQFdbQueue } from "./queue";
import { ExternalSlotSweepGuard, NuqFdbExternalSlots } from "./slots";

const DEFAULT_SWEEP_LOCK_TTL_MS = 15_000;
const DEFAULT_MAX_PARTITIONS_PER_TICK = 32;
const PARTITION_WORK_BUDGET_MS = 30_000;
const SWEEP_BATCH = 100;
const GROUP_MEMBER_SCAN_BATCH = 500;
const GROUP_MEMBER_MUTATION_BATCH = 50;
const GROUP_GC_BATCH = 500;
const ABANDONED_GROUP_DRAIN_GRACE_MS = 60 * 60 * 1000;
const FINISHED_CONTROL_RECHECK_MS = 60_000;
const STALL_FAILED_REASON = "Job stalled too many times";

class OwnershipLostError extends Error {}

type OwnershipRecord = {
  w: string;
  g: string;
  x: number;
};

type LegacyOwnershipRecord = {
  w: string;
  x: number;
  p?: 2; // partitioned protocol marker; old binaries ignore this field
};

const PARTITIONED_LEGACY_OWNER = "partitioned-v2";
const LEGACY_COMPAT_TTL_MS = 60_000;
const LEGACY_COMPAT_RENEW_AHEAD_MS = 30_000;

type PartitionClaim = {
  ks: NuqFdbKeyspace;
  phase: string;
  partition: number;
  generation: string;
  expiresAt: number;
  lifecycleGeneration?: number;
};

type TickErrorDisposition = "transient" | "fatal";
type TickErrorClassifier = (error: unknown) => TickErrorDisposition;

// foundationdb@2 exposes native failures as FDBError instances whose stable
// cross-package shape is Error + numeric code. Avoid importing the constructor
// at runtime: doing so eagerly loads libfdb_c in processes that do not use FDB,
// and instanceof would fail if more than one package copy were loaded.
function defaultTickErrorClassifier(error: unknown): TickErrorDisposition {
  if (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === "number" &&
    Number.isInteger((error as Error & { code: number }).code)
  ) {
    return "transient";
  }
  return "fatal";
}

type OverdueObservation = {
  queue: string;
  index: string;
  partition: number;
  oldestDueAtMs: number;
  ownershipExpiresAtMs: number;
};

type PartitionWork = {
  ks: NuqFdbKeyspace;
  phase: string;
  partition: number;
  run: (claim: PartitionClaim) => Promise<void>;
};

type SweepLagStats = {
  dueCount: number;
  processedCount: number;
  oldestOverdueAgeMs: number;
  saturatedBatchCount: number;
  budgetExhausted: boolean;
  durationMs: number;
};

function keyAfter(key: Buffer): Buffer {
  return Buffer.concat([key, Buffer.from([0])]);
}

function escapePrometheusLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
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
    saturatedBatchCount: 0,
    budgetExhausted: false,
    durationMs: 0,
  };
}

// Maintenance is split into independently leased queue/index/bucket
// partitions. Replicas race for a bounded number of partitions per tick, so
// adding replicas adds throughput while a fencing generation prevents overlap.
export class NuqFdbSweeper {
  private readonly sweeperId = randomUUID();
  private loop: NodeJS.Timeout | null = null;
  private running = false;
  private stopRequested = true;
  private healthy = false;
  private runGeneration = 0;
  private donePromise: Promise<void> = Promise.resolve();
  private resolveDone: (() => void) | null = null;
  private rejectDone: ((error: unknown) => void) | null = null;
  private metricsEnabled = true;
  private partitionOffset = 0;
  private readonly overdueObservations = new Map<string, OverdueObservation>();
  private readonly lockTtlMs: number;
  private readonly maxPartitionsPerTick: number;
  private readonly classifyTickError: TickErrorClassifier;

  constructor(
    public readonly queues: NuQFdbQueue[],
    public readonly externalSlots: NuqFdbExternalSlots[] = [],
    options: {
      lockTtlMs?: number;
      maxPartitionsPerTick?: number;
      classifyTickError?: TickErrorClassifier;
    } = {},
  ) {
    this.lockTtlMs = options.lockTtlMs ?? DEFAULT_SWEEP_LOCK_TTL_MS;
    this.maxPartitionsPerTick =
      options.maxPartitionsPerTick ?? DEFAULT_MAX_PARTITIONS_PER_TICK;
    this.classifyTickError =
      options.classifyTickError ?? defaultTickErrorClassifier;
  }

  private get db() {
    return getNuqFdbDatabase();
  }

  private async tryAcquirePartition(
    ks: NuqFdbKeyspace,
    phase: string,
    partition: number,
    now: number = Date.now(),
    lifecycleGeneration?: number,
  ): Promise<PartitionClaim | null> {
    const generation = randomUUID();
    const claim = await this.db.doTn(async tn => {
      // During rolling deployment, defer to the old all-or-nothing owner until
      // its final lease expires; old and new protocols must not overlap.
      const legacyKey = this.queues[0].ks.legacySweeperLock();
      const legacy = decodeJson<LegacyOwnershipRecord>(await tn.get(legacyKey));
      if (legacy && legacy.x > now && legacy.p !== 2) return null;
      // A shared v2 marker blocks old singleton sweepers while allowing all
      // partitioned replicas to claim disjoint work during rolling deploys.
      // Renew it infrequently to avoid turning compatibility into a hot write.
      if (
        !legacy ||
        legacy.p !== 2 ||
        legacy.x <= now + LEGACY_COMPAT_RENEW_AHEAD_MS
      ) {
        tn.set(
          legacyKey,
          encodeJson({
            w: PARTITIONED_LEGACY_OWNER,
            p: 2,
            x: now + LEGACY_COMPAT_TTL_MS,
          } satisfies LegacyOwnershipRecord),
        );
      }
      const key = ks.sweeperPartition(phase, partition);
      const current = decodeJson<OwnershipRecord>(await tn.get(key));
      if (current && current.x > now && current.w !== this.sweeperId) {
        return null;
      }
      const expiresAt = now + this.lockTtlMs;
      tn.set(
        key,
        encodeJson({
          w: this.sweeperId,
          g: generation,
          x: expiresAt,
        } satisfies OwnershipRecord),
      );
      return {
        ks,
        phase,
        partition,
        generation,
        expiresAt,
        lifecycleGeneration,
      };
    });
    // A new claim must be repopulated only by its own scan. A failed claim
    // means another replica owns the partition, so this process must not keep
    // exporting an observation from an earlier generation. A detached pass is
    // not allowed to clear observations belonging to a restarted lifecycle.
    this.clearOverdueObservation(ks, phase, partition, lifecycleGeneration);
    return claim;
  }

  private assertCurrentLifecycleClaim(claim: PartitionClaim): void {
    if (
      claim.lifecycleGeneration !== undefined &&
      claim.lifecycleGeneration !== this.runGeneration
    ) {
      throw new OwnershipLostError();
    }
  }

  private async renewClaim(claim: PartitionClaim): Promise<void> {
    this.assertCurrentLifecycleClaim(claim);
    const expiresAt = await this.db.doTn(async tn => {
      this.assertCurrentLifecycleClaim(claim);
      const key = claim.ks.sweeperPartition(claim.phase, claim.partition);
      const current = decodeJson<OwnershipRecord>(await tn.get(key));
      this.assertCurrentLifecycleClaim(claim);
      const legacyKey = this.queues[0].ks.legacySweeperLock();
      const legacy = decodeJson<LegacyOwnershipRecord>(await tn.get(legacyKey));
      this.assertCurrentLifecycleClaim(claim);
      const now = Date.now();
      if (
        !current ||
        current.w !== this.sweeperId ||
        current.g !== claim.generation ||
        current.x <= now ||
        !legacy ||
        legacy.p !== 2
      ) {
        throw new OwnershipLostError();
      }
      const expiresAt = now + this.lockTtlMs;
      tn.set(key, encodeJson({ ...current, x: expiresAt }));
      if (legacy.x <= now + LEGACY_COMPAT_RENEW_AHEAD_MS) {
        tn.set(
          legacyKey,
          encodeJson({
            w: PARTITIONED_LEGACY_OWNER,
            p: 2,
            x: now + LEGACY_COMPAT_TTL_MS,
          } satisfies LegacyOwnershipRecord),
        );
      }
      return expiresAt;
    });
    this.assertCurrentLifecycleClaim(claim);
    claim.expiresAt = expiresAt;
    const observation = this.overdueObservations.get(
      this.observationKey(claim.ks, claim.phase, claim.partition),
    );
    if (observation) observation.ownershipExpiresAtMs = expiresAt;
  }

  private async guardClaim(
    tn: Transaction,
    claim: PartitionClaim,
  ): Promise<void> {
    this.assertCurrentLifecycleClaim(claim);
    const current = decodeJson<OwnershipRecord>(
      await tn.get(claim.ks.sweeperPartition(claim.phase, claim.partition)),
    );
    this.assertCurrentLifecycleClaim(claim);
    const legacy = decodeJson<LegacyOwnershipRecord>(
      await tn.get(this.queues[0].ks.legacySweeperLock()),
    );
    this.assertCurrentLifecycleClaim(claim);
    if (
      !current ||
      current.w !== this.sweeperId ||
      current.g !== claim.generation ||
      current.x <= Date.now() ||
      !legacy ||
      legacy.p !== 2 ||
      legacy.x <= Date.now()
    ) {
      throw new OwnershipLostError();
    }
  }

  private guard(claim: PartitionClaim): ExternalSlotSweepGuard {
    return async tn => await this.guardClaim(tn, claim);
  }

  private partitionWork(now: number, logger: Logger): PartitionWork[] {
    const work: PartitionWork[] = [];
    for (const queue of this.queues) {
      for (let bucket = 0; bucket < TIME_BUCKETS; bucket++) {
        work.push(
          {
            ks: queue.ks,
            phase: "lease",
            partition: bucket,
            run: claim => this.sweepLeases(queue, bucket, now, logger, claim),
          },
          {
            ks: queue.ks,
            phase: "backlog-timeout",
            partition: bucket,
            run: claim =>
              this.sweepBacklogTimeouts(queue, bucket, now, logger, claim),
          },
          {
            ks: queue.ks,
            phase: "delay",
            partition: bucket,
            run: claim => this.sweepDelayed(queue, bucket, now, logger, claim),
          },
          {
            ks: queue.ks,
            phase: "job-expiry",
            partition: bucket,
            run: claim => this.sweepJobExpiry(queue, bucket, now, claim),
          },
          {
            ks: queue.ks,
            phase: "group-finish",
            partition: bucket,
            run: claim =>
              this.sweepGroupFinishTasks(
                queue,
                now,
                claim,
                queue.ks.taskGroupFinishRange(bucket),
              ),
          },
          {
            ks: queue.ks,
            phase: "group-cancel",
            partition: bucket,
            run: claim =>
              this.sweepGroupCancelTasks(
                queue,
                now,
                claim,
                queue.ks.taskGroupCancelRange(bucket),
              ),
          },
          {
            ks: queue.ks,
            phase: "team-raise",
            partition: bucket,
            run: claim =>
              this.sweepTeamRaiseTasks(
                queue,
                claim,
                queue.ks.taskTeamRaiseRange(bucket),
              ),
          },
          {
            ks: queue.ks,
            phase: "key-raise",
            partition: bucket,
            run: claim =>
              this.sweepKeyRaiseTasks(
                queue,
                claim,
                queue.ks.taskKeyRaiseRange(bucket),
              ),
          },
          {
            ks: queue.ks,
            phase: "group-expiry",
            partition: bucket,
            run: claim =>
              this.sweepGroupExpiry(
                queue,
                now,
                claim,
                queue.ks.groupExpiryScanRange(bucket, now),
                false,
              ),
          },
          {
            ks: queue.ks,
            phase: "team-ledger-gc",
            partition: bucket,
            run: claim => this.sweepLedgers(queue, "team", bucket, claim),
          },
          {
            ks: queue.ks,
            phase: "key-ledger-gc",
            partition: bucket,
            run: claim => this.sweepLedgers(queue, "key", bucket, claim),
          },
        );
      }
      work.push(
        {
          ks: queue.ks,
          phase: "legacy-group-finish",
          partition: 0,
          run: claim =>
            this.sweepGroupFinishTasks(
              queue,
              now,
              claim,
              queue.ks.legacyTaskGroupFinishRange(),
            ),
        },
        {
          ks: queue.ks,
          phase: "legacy-group-cancel",
          partition: 0,
          run: claim =>
            this.sweepGroupCancelTasks(
              queue,
              now,
              claim,
              queue.ks.legacyTaskGroupCancelRange(),
            ),
        },
        {
          ks: queue.ks,
          phase: "legacy-team-raise",
          partition: 0,
          run: claim =>
            this.sweepTeamRaiseTasks(
              queue,
              claim,
              queue.ks.legacyTaskTeamRaiseRange(),
            ),
        },
        {
          ks: queue.ks,
          phase: "legacy-key-raise",
          partition: 0,
          run: claim =>
            this.sweepKeyRaiseTasks(
              queue,
              claim,
              queue.ks.legacyTaskKeyRaiseRange(),
            ),
        },
        {
          ks: queue.ks,
          phase: "legacy-group-expiry",
          partition: 0,
          run: claim =>
            this.sweepGroupExpiry(
              queue,
              now,
              claim,
              queue.ks.legacyGroupExpiryScanRange(now),
              true,
            ),
        },
        {
          ks: queue.ks,
          phase: "legacy-active-group-index",
          partition: 0,
          run: claim => this.indexLegacyActiveGroups(queue, claim),
        },
        {
          ks: queue.ks,
          phase: "legacy-all-group-index",
          partition: 0,
          run: claim => this.indexLegacyGroups(queue, claim),
        },
        {
          ks: queue.ks,
          phase: "legacy-team-ledger-index",
          partition: 0,
          run: claim => this.indexLegacyLedgers(queue, "team", claim),
        },
        {
          ks: queue.ks,
          phase: "legacy-key-ledger-index",
          partition: 0,
          run: claim => this.indexLegacyLedgers(queue, "key", claim),
        },
        {
          ks: queue.ks,
          phase: "claim-marker",
          partition: 0,
          run: claim => this.sweepClaimMarkers(queue, now, claim),
        },
        {
          ks: queue.ks,
          phase: "abandoned-ingest",
          partition: 0,
          run: claim => this.sweepAbandonedIngests(queue, now, claim),
        },
      );
    }
    for (const slots of this.externalSlots) {
      for (let bucket = 0; bucket < TIME_BUCKETS; bucket++) {
        work.push({
          ks: slots.ks,
          phase: "external-expiry",
          partition: bucket,
          run: async claim => {
            await this.renewClaim(claim);
            await slots.sweepExpiredBucket(
              now,
              bucket,
              this.guard(claim),
              due =>
                this.observeDue(claim, "external_expiry", due, key =>
                  Number(claim.ks.unpack(key)[4]),
                ),
            );
          },
        });
      }
    }
    return work;
  }

  // Exposed for real-FDB tests. Direct calls attempt every partition; the
  // production loop caps claims so replicas naturally divide the work.
  public async sweepOnce(
    logger: Logger = _logger,
    maxPartitions: number = Number.POSITIVE_INFINITY,
    lifecycleGeneration?: number,
  ): Promise<void> {
    const now = Date.now();
    const startedAt = Date.now();
    for (const queue of this.queues) {
      if (
        lifecycleGeneration !== undefined &&
        lifecycleGeneration !== this.runGeneration
      ) {
        return;
      }
      await queue.backfillMetricCounts(100, config.NUQ_FDB_METRICS_V2_ACTIVATE);
      if (
        lifecycleGeneration !== undefined &&
        lifecycleGeneration !== this.runGeneration
      ) {
        return;
      }
    }
    const work = this.partitionWork(now, logger);
    const offset = this.partitionOffset % Math.max(1, work.length);
    const ordered = [...work.slice(offset), ...work.slice(0, offset)];
    let acquired = 0;
    let scanned = 0;
    for (const item of ordered) {
      if (
        (lifecycleGeneration !== undefined &&
          lifecycleGeneration !== this.runGeneration) ||
        acquired >= maxPartitions ||
        (Number.isFinite(maxPartitions) &&
          Date.now() - startedAt >= PARTITION_WORK_BUDGET_MS)
      ) {
        break;
      }
      scanned++;
      this.partitionOffset = (offset + scanned) % work.length;
      const claim = await this.tryAcquirePartition(
        item.ks,
        item.phase,
        item.partition,
        Date.now(),
        lifecycleGeneration,
      );
      if (
        lifecycleGeneration !== undefined &&
        lifecycleGeneration !== this.runGeneration
      ) {
        break;
      }
      if (!claim) continue;
      acquired++;
      try {
        await item.run(claim);
      } catch (error) {
        if (error instanceof OwnershipLostError) {
          this.clearOverdueObservation(
            item.ks,
            item.phase,
            item.partition,
            lifecycleGeneration,
          );
          logger.info("NuQ FDB sweeper partition ownership lost", {
            canonicalLog: "nuq-fdb/sweeper_ownership_lost",
            queueName: item.ks.queueName,
            phase: item.phase,
            partition: item.partition,
          });
          continue;
        }
        throw error;
      }
    }
  }

  public start(intervalMs: number = 1000, logger: Logger = _logger): void {
    if (!this.stopRequested || this.loop || this.running) return;
    const lifecycleGeneration = ++this.runGeneration;
    this.stopRequested = false;
    this.healthy = true;
    this.metricsEnabled = true;
    this.donePromise = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // A lifecycle supervisor attaches immediately after start(), but retain a
    // rejection handler here as well so a very short interval cannot create an
    // unhandled rejection before the component is registered.
    void this.donePromise.catch(() => undefined);
    this.loop = setInterval(() => {
      if (
        lifecycleGeneration !== this.runGeneration ||
        this.running ||
        this.stopRequested
      ) {
        return;
      }
      this.running = true;
      void this.sweepOnce(
        logger,
        this.maxPartitionsPerTick,
        lifecycleGeneration,
      ).then(
        () => this.completeTick(lifecycleGeneration),
        error => this.rejectTick(lifecycleGeneration, error, logger),
      );
    }, intervalMs);
  }

  public stop(): void {
    const lifecycleGeneration = this.runGeneration;
    this.stopRequested = true;
    this.healthy = false;
    this.metricsEnabled = false;
    this.overdueObservations.clear();
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    if (!this.running) this.finishLifecycle(lifecycleGeneration);
  }

  // Shutdown deadlines may not wait for a long FDB pass. Invalidate the run so
  // a detached pass cannot mutate a restarted lifecycle when it later settles.
  public forceStop(): void {
    const resolve = this.resolveDone;
    const hasActiveLifecycle =
      resolve !== null ||
      this.rejectDone !== null ||
      this.loop !== null ||
      this.running;
    this.stopRequested = true;
    this.healthy = false;
    this.metricsEnabled = false;
    this.overdueObservations.clear();
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.running = false;
    this.resolveDone = null;
    this.rejectDone = null;
    if (hasActiveLifecycle) this.runGeneration++;
    resolve?.();
  }

  public get done(): Promise<void> {
    return this.donePromise;
  }

  public isHealthy(): boolean {
    return this.healthy && !this.stopRequested && this.loop !== null;
  }

  private completeTick(lifecycleGeneration: number): void {
    if (lifecycleGeneration !== this.runGeneration) return;
    this.running = false;
    if (this.stopRequested) {
      this.finishLifecycle(lifecycleGeneration);
      return;
    }
    this.healthy = true;
  }

  private rejectTick(
    lifecycleGeneration: number,
    error: unknown,
    logger: Logger,
  ): void {
    if (lifecycleGeneration !== this.runGeneration) return;
    this.running = false;
    if (this.stopRequested) {
      this.finishLifecycle(lifecycleGeneration);
      return;
    }

    let disposition: TickErrorDisposition;
    try {
      disposition = this.classifyTickError(error);
    } catch (classifierError) {
      const logging = this.tryLog(logger, "error", {
        message: "NuQ FDB sweeper error classifier failed",
        meta: {
          module: "nuq-fdb/sweeper",
          error: classifierError,
          tickError: error,
        },
      });
      this.failLifecycle(
        lifecycleGeneration,
        logging.ok ? classifierError : logging.error,
      );
      return;
    }

    if (disposition === "transient") {
      this.healthy = false;
      const logging = this.tryLog(logger, "warn", {
        message: "NuQ FDB sweeper tick failed transiently; retrying",
        meta: { module: "nuq-fdb/sweeper", error },
      });
      if (!logging.ok) {
        this.failLifecycle(lifecycleGeneration, logging.error);
      }
      return;
    }

    const logging = this.tryLog(logger, "error", {
      message: "NuQ FDB sweeper loop failed fatally",
      meta: { module: "nuq-fdb/sweeper", error },
    });
    this.failLifecycle(lifecycleGeneration, logging.ok ? error : logging.error);
  }

  private tryLog(
    logger: Logger,
    level: "warn" | "error",
    entry: { message: string; meta: Record<string, unknown> },
  ): { ok: true } | { ok: false; error: unknown } {
    try {
      logger[level](entry.message, entry.meta);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  private finishLifecycle(lifecycleGeneration: number): void {
    if (lifecycleGeneration !== this.runGeneration) return;
    const resolve = this.resolveDone;
    this.resolveDone = null;
    this.rejectDone = null;
    resolve?.();
  }

  private failLifecycle(lifecycleGeneration: number, error: unknown): void {
    if (lifecycleGeneration !== this.runGeneration) return;
    const reject = this.rejectDone;
    this.stopRequested = true;
    this.healthy = false;
    this.metricsEnabled = false;
    this.overdueObservations.clear();
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.resolveDone = null;
    this.rejectDone = null;
    reject?.(error);
  }

  private observationKey(
    ks: NuqFdbKeyspace,
    phase: string,
    partition: number,
  ): string {
    return JSON.stringify([ks.queueName, phase, partition]);
  }

  private clearOverdueObservation(
    ks: NuqFdbKeyspace,
    phase: string,
    partition: number,
    lifecycleGeneration?: number,
  ): void {
    if (
      lifecycleGeneration !== undefined &&
      lifecycleGeneration !== this.runGeneration
    ) {
      return;
    }
    this.overdueObservations.delete(this.observationKey(ks, phase, partition));
  }

  private observeDue(
    claim: PartitionClaim,
    index: string,
    due: readonly [unknown, unknown][],
    dueAt: (key: Buffer) => number,
  ): void {
    if (
      claim.lifecycleGeneration !== undefined &&
      claim.lifecycleGeneration !== this.runGeneration
    ) {
      return;
    }
    const key = this.observationKey(claim.ks, claim.phase, claim.partition);
    if (!this.metricsEnabled || due.length === 0) {
      this.overdueObservations.delete(key);
      return;
    }
    let oldestDueAtMs = Number.POSITIVE_INFINITY;
    for (const [rawKey] of due) {
      const value = dueAt(rawKey as Buffer);
      if (Number.isFinite(value))
        oldestDueAtMs = Math.min(oldestDueAtMs, value);
    }
    if (!Number.isFinite(oldestDueAtMs)) {
      this.overdueObservations.delete(key);
      return;
    }
    this.overdueObservations.set(key, {
      queue: claim.ks.queueName,
      index,
      partition: claim.partition,
      oldestDueAtMs,
      ownershipExpiresAtMs: claim.expiresAt,
    });
  }

  // Pure in-memory collector: scans populate observations while metrics
  // collection performs no FoundationDB reads. Expired local claims are
  // removed here so a stopped or partitioned pod cannot pin autoscaling.
  public getMetrics(nowMs: number = Date.now()): string {
    const rows: string[] = [];
    const observations = [...this.overdueObservations.entries()].sort(
      ([a], [b]) => a.localeCompare(b),
    );
    for (const [key, observation] of observations) {
      if (!this.metricsEnabled || observation.ownershipExpiresAtMs <= nowMs) {
        this.overdueObservations.delete(key);
        continue;
      }
      const labels = `queue="${escapePrometheusLabel(observation.queue)}",index="${escapePrometheusLabel(observation.index)}",partition="${observation.partition}"`;
      const seconds = Math.max(0, nowMs - observation.oldestDueAtMs) / 1000;
      rows.push(
        `firecrawl_nuq_fdb_sweeper_oldest_overdue_seconds{${labels}} ${seconds}`,
      );
    }
    return [
      "# HELP firecrawl_nuq_fdb_sweeper_oldest_overdue_seconds Age of the oldest overdue entry observed by an owned NuQ FDB sweeper partition",
      "# TYPE firecrawl_nuq_fdb_sweeper_oldest_overdue_seconds gauge",
      ...rows,
      "",
    ].join("\n");
  }

  private addLag(
    stats: SweepLagStats,
    ks: NuqFdbKeyspace,
    due: [unknown, unknown][],
    now: number,
  ): void {
    stats.dueCount += due.length;
    if (due.length >= SWEEP_BATCH) stats.saturatedBatchCount++;
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

  private logLag(
    logger: Logger,
    queue: NuQFdbQueue,
    index: string,
    stats: SweepLagStats,
  ): void {
    if (stats.dueCount === 0 && !stats.budgetExhausted) return;
    logger[
      stats.budgetExhausted || stats.saturatedBatchCount > 0 ? "warn" : "debug"
    ]("NuQ FDB sweeper lag", {
      canonicalLog: "nuq-fdb/sweeper_lag",
      queueName: queue.queueName,
      index,
      partitioned: true,
      timeBuckets: TIME_BUCKETS,
      sweepBatch: SWEEP_BATCH,
      ...stats,
    });
  }

  private async dueBatch(
    claim: PartitionClaim,
    range: { begin: Buffer; end: Buffer },
    limit: number = SWEEP_BATCH,
  ): Promise<[Buffer, Buffer][]> {
    await this.renewClaim(claim);
    return await this.db.doTn(async tn => {
      await this.guardClaim(tn, claim);
      return (await tn
        .snapshot()
        .getRangeAll(range.begin, range.end, { limit })) as [Buffer, Buffer][];
    });
  }

  private async sweepLeases(
    queue: NuQFdbQueue,
    bucket: number,
    now: number,
    logger: Logger,
    claim: PartitionClaim,
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    const stats = emptySweepLagStats();
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const due = await this.dueBatch(claim, ks.leaseScanRange(bucket, now));
      this.observeDue(claim, "lease", due, key => Number(ks.unpackId(key, 1)));
      this.addLag(stats, ks, due, now);
      if (due.length === 0) break;
      for (const [key, value] of due) {
        await this.renewClaim(claim);
        const id = ks.unpackId(key);
        const lease = decodeJson<{ l: string }>(value);
        await this.db.doTn(async tn => {
          await this.guardClaim(tn, claim);
          const txc = newTxContext();
          const st = decodeJson<JobStatusRecord>(
            await tn.get(ks.jobStatus(id)),
          );
          if (!st || st.s !== "active" || st.l !== lease?.l) {
            tn.clear(key);
            return;
          }
          if (st.e !== undefined && st.e > now) {
            tn.clear(key);
            return;
          }
          const meta = decodeJson<JobMeta>(await tn.get(ks.jobMeta(id)));
          tn.clear(key);
          if (!meta) return;
          const entry = entryFromMeta(id, meta);
          if (st.st < MAX_STALLS) {
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
      if (due.length < SWEEP_BATCH) break;
    }
    stats.budgetExhausted = Date.now() - startedAt >= PARTITION_WORK_BUDGET_MS;
    stats.durationMs = Date.now() - startedAt;
    this.logLag(logger, queue, "lease", stats);
  }

  private async sweepBacklogTimeouts(
    queue: NuQFdbQueue,
    bucket: number,
    now: number,
    logger: Logger,
    claim: PartitionClaim,
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    const stats = emptySweepLagStats();
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const due = await this.dueBatch(
        claim,
        ks.backlogTimeoutScanRange(bucket, now),
      );
      this.observeDue(claim, "backlog_timeout", due, key =>
        Number(ks.unpackId(key, 1)),
      );
      this.addLag(stats, ks, due, now);
      if (due.length === 0) break;
      for (const [key] of due) {
        await this.renewClaim(claim);
        const id = ks.unpackId(key);
        await this.db.doTn(async tn => {
          await this.guardClaim(tn, claim);
          const txc = newTxContext();
          tn.clear(key);
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
            if (meta.f & F_COUNTABLE) {
              bumpGroupStatusCount(tn, ks, meta.g, "pending", -1);
            }
            tn.set(ks.taskGroupFinish(meta.g), EMPTY);
          }
          deleteJobRecords(tn, ks, id);
          await alignQueueMetricStatus(tn, ks, id);
        });
        stats.processedCount++;
      }
      if (due.length < SWEEP_BATCH) break;
    }
    stats.budgetExhausted = Date.now() - startedAt >= PARTITION_WORK_BUDGET_MS;
    stats.durationMs = Date.now() - startedAt;
    this.logLag(logger, queue, "backlog_timeout", stats);
  }

  private async sweepDelayed(
    queue: NuQFdbQueue,
    bucket: number,
    now: number,
    logger: Logger,
    claim: PartitionClaim,
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    const stats = emptySweepLagStats();
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const due = await this.dueBatch(claim, ks.delayedScanRange(bucket, now));
      this.observeDue(claim, "delay", due, key => Number(ks.unpackId(key, 1)));
      this.addLag(stats, ks, due, now);
      if (due.length === 0) break;
      for (const [key, value] of due) {
        const entry = decodeJson<QueueEntry>(value);
        if (!entry) continue;
        await this.renewClaim(claim);
        await this.db.doTn(async tn => {
          await this.guardClaim(tn, claim);
          const txc = newTxContext();
          const st = decodeJson<JobStatusRecord>(
            await tn.get(ks.jobStatus(entry.i)),
          );
          tn.clear(key);
          if (!st || st.s !== "pending" || st.loc?.k !== "dl") return;
          await admitThroughGates(tn, ks, entry, txc);
          await alignQueueMetricStatus(tn, ks, entry.i);
        });
        stats.processedCount++;
      }
      if (due.length < SWEEP_BATCH) break;
    }
    stats.budgetExhausted = Date.now() - startedAt >= PARTITION_WORK_BUDGET_MS;
    stats.durationMs = Date.now() - startedAt;
    this.logLag(logger, queue, "delay", stats);
  }

  private async sweepClaimMarkers(
    queue: NuQFdbQueue,
    now: number,
    claim: PartitionClaim,
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    const range = ks.claimExpiryScanRange(now);
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const due = await this.dueBatch(claim, range);
      this.observeDue(claim, "claim_expiry", due, key =>
        Number(ks.unpackId(key, 1)),
      );
      if (due.length === 0) break;
      await this.renewClaim(claim);
      await this.db.doTn(async tn => {
        await this.guardClaim(tn, claim);
        for (const [key] of due) {
          const op = ks.unpackId(key);
          const expiresAt = Number(ks.unpackId(key, 1));
          const marker = decodeJson<{ e: number }>(await tn.get(ks.claim(op)));
          if (marker && marker.e === expiresAt && marker.e <= now) {
            tn.clear(ks.claim(op));
          }
          // Always discard the observed expiry row. A mismatched/live marker
          // has its own later durable row and must survive stale-row cleanup.
          tn.clear(key);
        }
      });
      if (due.length < SWEEP_BATCH) break;
    }
  }

  private async sweepAbandonedIngests(
    queue: NuQFdbQueue,
    now: number,
    claim: PartitionClaim,
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    const range = ks.ingestExpiryScanRange(now);
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const due = await this.dueBatch(claim, range, 20);
      this.observeDue(claim, "ingest_expiry", due, key =>
        Number(ks.unpackId(key, 1)),
      );
      if (due.length === 0) break;
      let incomplete = false;
      for (const [expiryKey] of due) {
        await this.renewClaim(claim);
        const op = ks.unpackId(expiryKey);
        const finished = await this.db.doTn(async tn => {
          await this.guardClaim(tn, claim);
          const meta = decodeJson<IngestMeta>(await tn.get(ks.ingest(op)));
          if (!meta) {
            tn.clear(expiryKey);
            return true;
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
          if (members.length >= SWEEP_BATCH) return false;

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
          if (groups.length >= SWEEP_BATCH) return false;

          if (meta.r > 0 && meta.o) {
            tn.add(ks.teamIngestReserved(meta.o), encodeI64(-meta.r));
          }
          tn.clear(ks.ingest(op));
          tn.clear(expiryKey);
          return true;
        });
        if (!finished) incomplete = true;
        if (Date.now() - startedAt >= PARTITION_WORK_BUDGET_MS) return;
      }
      if (!incomplete && due.length < 20) break;
    }
  }

  private async taskBatch(
    claim: PartitionClaim,
    range: { begin: Buffer; end: Buffer },
    limit: number,
  ): Promise<[Buffer, Buffer][]> {
    await this.renewClaim(claim);
    return await this.db.doTn(async tn => {
      await this.guardClaim(tn, claim);
      const cursor = await tn
        .snapshot()
        .get(claim.ks.sweeperCursor(claim.phase, claim.partition));
      let rows = (await tn
        .snapshot()
        .getRangeAll(cursor ? keyAfter(cursor) : range.begin, range.end, {
          limit,
        })) as [Buffer, Buffer][];
      if (rows.length === 0 && cursor) {
        tn.clear(claim.ks.sweeperCursor(claim.phase, claim.partition));
        rows = (await tn
          .snapshot()
          .getRangeAll(range.begin, range.end, { limit })) as [
          Buffer,
          Buffer,
        ][];
      }
      if (rows.length > 0) {
        tn.set(
          claim.ks.sweeperCursor(claim.phase, claim.partition),
          rows[rows.length - 1][0],
        );
      }
      return rows;
    });
  }

  private async sweepGroupFinishTasks(
    queue: NuQFdbQueue,
    now: number,
    claim: PartitionClaim,
    range: { begin: Buffer; end: Buffer },
  ): Promise<void> {
    if (!queue.groupOps) return;
    const startedAt = Date.now();
    const ks = queue.ks;
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const tasks = await this.taskBatch(claim, range, SWEEP_BATCH);
      if (tasks.length === 0) break;
      for (const [key] of tasks) {
        const gid = ks.unpackId(key);
        await this.renewClaim(claim);
        await this.db.doTn(async tn => {
          await this.guardClaim(tn, claim);
          const txc = newTxContext();
          const rem = decodeI64(await tn.get(ks.groupRemaining(gid)));
          if (rem > 0) {
            tn.clear(key);
            return;
          }
          await queue.groupOps!.tryCompleteGroup(tn, gid, now, txc);
          tn.clear(key);
        });
      }
      if (tasks.length < SWEEP_BATCH) break;
    }
  }

  private async sweepGroupCancelTasks(
    queue: NuQFdbQueue,
    now: number,
    claim: PartitionClaim,
    range: { begin: Buffer; end: Buffer },
  ): Promise<void> {
    if (!queue.groupOps) return;
    const startedAt = Date.now();
    const ks = queue.ks;
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const tasks = await this.taskBatch(claim, range, 20);
      if (tasks.length === 0) break;
      for (const [key] of tasks) {
        await this.cleanCancelledGroup(
          queue,
          ks.unpackId(key),
          now,
          claim,
          key,
        );
        if (Date.now() - startedAt >= PARTITION_WORK_BUDGET_MS) break;
      }
      if (tasks.length < 20) break;
    }
  }

  private async cleanCancelledGroup(
    queue: NuQFdbQueue,
    gid: string,
    now: number,
    claim: PartitionClaim,
    observedTaskKey: Buffer,
  ): Promise<void> {
    const ks = queue.ks;
    const startedAt = Date.now();
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      await this.renewClaim(claim);
      const result = await this.db.doTn(async tn => {
        await this.guardClaim(tn, claim);
        const g = decodeJson<GroupMeta>(await tn.get(ks.groupMeta(gid)));
        if (!g || (g.s !== "cancelled" && g.s !== "active")) {
          tn.clear(ks.taskGroupCancel(gid));
          tn.clear(observedTaskKey);
          tn.clear(ks.groupCancelCursor(gid));
          return { exhausted: true, progressed: false };
        }
        const jr = ks.groupJobRange(gid);
        const cursor = await tn.get(ks.groupCancelCursor(gid));
        const members = await tn
          .snapshot()
          .getRangeAll(cursor ? keyAfter(cursor) : jr.begin, jr.end, {
            limit: GROUP_MEMBER_SCAN_BATCH,
          });
        let cleaned = 0;
        let visited = 0;
        let lastKey: Buffer | null = null;
        for (const [rawKey, rawValue] of members) {
          const memberKey = rawKey as Buffer;
          lastKey = memberKey;
          visited++;
          const gj = decodeJson<GroupJobIndexValue>(rawValue as Buffer);
          if (!gj || (gj.s !== "pending" && !g.z)) continue;
          const id = ks.unpackId(memberKey);
          const st = decodeJson<JobStatusRecord>(
            await tn.get(ks.jobStatus(id)),
          );
          const meta = decodeJson<JobMeta>(await tn.get(ks.jobMeta(id)));
          if (!st || !meta) {
            // Orphaned/stale index rows are removed so they cannot permanently
            // hide real pending members later in the range.
            tn.clear(memberKey);
            continue;
          }
          if (st.s === "pending" && st.loc) {
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
              bumpKeyActive(tn, ks, meta.k, -1);
              scheduleRaiseTask(tn, ks.taskKeyRaise(meta.k));
            }
            tn.clear(memberKey);
            tn.add(ks.groupRemaining(gid), MINUS_ONE);
            if (meta.f & F_COUNTABLE) {
              bumpGroupStatusCount(tn, ks, gid, "pending", -1);
            }
            deleteJobRecords(tn, ks, id);
            await alignQueueMetricStatus(tn, ks, id);
            cleaned++;
          } else if (g.z && (st.s === "queued" || st.s === "active")) {
            tn.set(
              ks.jobStatus(id),
              encodeJson({
                s: "cancelled",
                st: st.st,
              } satisfies JobStatusRecord),
            );
            await alignQueueMetricStatus(tn, ks, id);
            if (st.s === "active" && st.e !== undefined) {
              tn.clear(ks.lease(timeBucket(id), st.e, id));
            }
            await releaseSlotsAndPromote(
              tn,
              ks,
              entryFromMeta(id, meta),
              { team: true, key: true, crawl: true },
              now,
              newTxContext(),
            );
            tn.clear(memberKey);
            tn.add(ks.groupRemaining(gid), MINUS_ONE);
            if (meta.f & F_COUNTABLE) {
              bumpGroupStatusCount(tn, ks, gid, st.s, -1);
            }
            tn.set(
              ks.jobExpiry(
                timeBucket(id),
                now + COMPLETED_STANDALONE_RETENTION_MS,
                id,
              ),
              EMPTY,
            );
            cleaned++;
          } else if (gj.s !== st.s) {
            setGroupJobIndex(tn, ks, gid, id, gj.m === 1, st.s);
          }
          if (cleaned >= GROUP_MEMBER_MUTATION_BATCH) break;
        }
        const exhausted =
          members.length < GROUP_MEMBER_SCAN_BATCH &&
          visited === members.length;
        if (exhausted) {
          tn.clear(ks.groupCancelCursor(gid));
          tn.clear(ks.taskGroupCancel(gid));
          tn.clear(observedTaskKey);
          tn.set(ks.taskGroupFinish(gid), EMPTY);
        } else if (lastKey) {
          tn.set(ks.groupCancelCursor(gid), lastKey);
        }
        return { exhausted, progressed: visited > 0 };
      });
      if (result.exhausted || !result.progressed) break;
    }
  }

  private sameTaskGeneration(
    current: Buffer | undefined | null,
    observed: Buffer,
  ): boolean {
    if (!current) return false;
    // Pre-generation tasks used an empty value.
    if (current.length === 0 || observed.length === 0) {
      return current.length === observed.length;
    }
    const a = decodeJson<RaiseTask>(current);
    const b = decodeJson<RaiseTask>(observed);
    if (a?.g && b?.g) return a.g === b.g;
    // Compatibility with task keys written before generations were added.
    return current.equals(observed);
  }

  private async sweepTeamRaiseTasks(
    queue: NuQFdbQueue,
    claim: PartitionClaim,
    range: { begin: Buffer; end: Buffer },
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const tasks = await this.taskBatch(claim, range, SWEEP_BATCH);
      if (tasks.length === 0) break;
      for (const [key, observed] of tasks) {
        const tid = ks.unpackId(key);
        await this.renewClaim(claim);
        await this.db.doTn(async tn => {
          await this.guardClaim(tn, claim);
          const current = await tn.get(key);
          if (!this.sameTaskGeneration(current, observed)) return;
          const txc = newTxContext();
          const limitBuf = await tn.get(ks.teamLimit(tid));
          const limit = limitBuf ? decodeI64(limitBuf) : Infinity;
          const active = decodeI64(await tn.get(ks.teamActive(tid)));
          let free = Math.min(Math.max(0, limit - active), 32);
          let promoted = 0;
          while (free > 0) {
            const entry = await popTeamPending(tn, ks, tid);
            if (!entry) break;
            await promoteEntryToReady(tn, ks, entry, txc);
            promoted++;
            free--;
          }
          if (promoted > 0) bumpTeamActive(tn, ks, tid, promoted);
          const pending = decodeI64(await tn.get(ks.teamPendingCount(tid)));
          if (active + promoted >= limit || pending <= 0) tn.clear(key);
        });
      }
      if (tasks.length < SWEEP_BATCH) break;
    }
  }

  private async sweepKeyRaiseTasks(
    queue: NuQFdbQueue,
    claim: PartitionClaim,
    range: { begin: Buffer; end: Buffer },
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const tasks = await this.taskBatch(claim, range, SWEEP_BATCH);
      if (tasks.length === 0) break;
      for (const [key, observed] of tasks) {
        const kid = ks.unpackId(key);
        await this.renewClaim(claim);
        await this.db.doTn(async tn => {
          await this.guardClaim(tn, claim);
          const current = await tn.get(key);
          if (!this.sameTaskGeneration(current, observed)) return;
          const txc = newTxContext();
          const limitBuf = await tn.get(ks.keyLimit(kid));
          const limit = limitBuf ? decodeI64(limitBuf) : Infinity;
          const active = decodeI64(await tn.get(ks.keyActive(kid)));
          let free = Math.min(Math.max(0, limit - active), 32);
          let promoted = 0;
          while (free > 0) {
            const entry = await popKeyPending(tn, ks, kid);
            if (!entry) break;
            await admitThroughTeamGate(tn, ks, entry, txc);
            promoted++;
            free--;
          }
          if (promoted > 0) bumpKeyActive(tn, ks, kid, promoted);
          const pending = decodeI64(await tn.get(ks.keyPendingCount(kid)));
          if (active + promoted >= limit || pending <= 0) tn.clear(key);
        });
      }
      if (tasks.length < SWEEP_BATCH) break;
    }
  }

  private async sweepJobExpiry(
    queue: NuQFdbQueue,
    bucket: number,
    now: number,
    claim: PartitionClaim,
  ): Promise<void> {
    const startedAt = Date.now();
    const ks = queue.ks;
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const due = await this.dueBatch(
        claim,
        ks.jobExpiryScanRange(bucket, now),
        SWEEP_BATCH * 2,
      );
      this.observeDue(claim, "job_expiry", due, key =>
        Number(ks.unpackId(key, 1)),
      );
      if (due.length === 0) break;
      await this.renewClaim(claim);
      await this.db.doTn(async tn => {
        await this.guardClaim(tn, claim);
        for (const [key] of due) {
          const id = ks.unpackId(key);
          tn.clear(key);
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
      if (due.length < SWEEP_BATCH * 2) break;
    }
  }

  private async sweepGroupExpiry(
    queue: NuQFdbQueue,
    now: number,
    claim: PartitionClaim,
    range: { begin: Buffer; end: Buffer },
    legacy: boolean,
  ): Promise<void> {
    if (!queue.groupOps) return;
    const startedAt = Date.now();
    const ks = queue.ks;
    while (Date.now() - startedAt < PARTITION_WORK_BUDGET_MS) {
      const due = await this.dueBatch(claim, range, 20);
      this.observeDue(
        claim,
        legacy ? "legacy_group_expiry" : "group_expiry",
        due,
        key => Number(ks.unpack(key)[legacy ? 3 : 4]),
      );
      if (due.length === 0) break;
      for (const [key] of due) {
        const parts = ks.unpack(key);
        const expiresAt = Number(parts[legacy ? 3 : 4]);
        const gid = String(parts[legacy ? 4 : 5]);
        const generation = String(parts[legacy ? 5 : 6] ?? "");
        const action = await this.prepareGroupExpiry(
          queue,
          key,
          gid,
          expiresAt,
          generation,
          now,
          claim,
        );
        if (action === "gc") {
          await this.gcCompletedGroup(queue, key, gid, now, claim);
        }
      }
      if (due.length < 20) break;
    }
  }

  private async prepareGroupExpiry(
    queue: NuQFdbQueue,
    key: Buffer,
    gid: string,
    expiresAt: number,
    generation: string,
    now: number,
    claim: PartitionClaim,
  ): Promise<"gc" | "done"> {
    const ks = queue.ks;
    await this.renewClaim(claim);
    return await this.db.doTn(async tn => {
      await this.guardClaim(tn, claim);
      const g = decodeJson<GroupMeta>(await tn.get(ks.groupMeta(gid)));
      if (!g) {
        tn.clear(key);
        return "done";
      }
      const scheduledAt = g.s === "completed" ? g.x : g.a;
      if (scheduledAt !== expiresAt || (g.eg ?? "") !== generation) {
        tn.clear(key);
        return "done";
      }
      if (g.s === "active") {
        const nextAt = now + ABANDONED_GROUP_DRAIN_GRACE_MS;
        const nextGeneration = randomUUID();
        tn.set(
          ks.groupMeta(gid),
          encodeJson({
            ...g,
            s: "cancelled",
            a: nextAt,
            eg: nextGeneration,
          } satisfies GroupMeta),
        );
        tn.clear(ks.ongoingGroup(g.o, gid));
        tn.set(ks.taskGroupCancel(gid), EMPTY);
        tn.set(ks.taskGroupFinish(gid), EMPTY);
        tn.clear(key);
        tn.set(ks.groupExpiry(nextAt, gid, nextGeneration), EMPTY);
        return "done";
      }
      if (g.s === "cancelled") {
        // Normal cancellation lets active work finish. At the bounded
        // abandonment deadline, force tombstones so queued/active work cannot
        // keep the group forever. Move the expiry row forward while the
        // cursor-driven cancel task drains it, so one stuck group cannot hide
        // later expiry rows in this ordered range.
        const nextAt = now + FINISHED_CONTROL_RECHECK_MS;
        const nextGeneration = randomUUID();
        tn.set(
          ks.groupMeta(gid),
          encodeJson({
            ...g,
            z: true,
            a: nextAt,
            eg: nextGeneration,
          } satisfies GroupMeta),
        );
        tn.set(ks.taskGroupCancel(gid), EMPTY);
        tn.set(ks.taskGroupFinish(gid), EMPTY);
        tn.clear(key);
        tn.set(ks.groupExpiry(nextAt, gid, nextGeneration), EMPTY);
        return "done";
      }
      return "gc";
    });
  }

  private async gcCompletedGroup(
    queue: NuQFdbQueue,
    expiryKey: Buffer,
    gid: string,
    now: number,
    claim: PartitionClaim,
  ): Promise<void> {
    const ks = queue.ks;
    const finishedKs = queue.groupOps!.finishedKs;

    // Never remove crawl-finished control work while it can still be consumed
    // or is actively being processed. Move the group expiry generation
    // forward and retry after a bounded interval instead.
    if (finishedKs) {
      await this.renewClaim(claim);
      const deferred = await this.db.doTn(async tn => {
        await this.guardClaim(tn, claim);
        const fjobBuf = await tn.get(ks.groupFinishedJob(gid));
        if (!fjobBuf) return false;
        const fid = fjobBuf.toString("utf8");
        const status = decodeJson<JobStatusRecord>(
          await tn.get(finishedKs.jobStatus(fid)),
        );
        if (status?.s !== "queued" && status?.s !== "active") return false;
        const g = decodeJson<GroupMeta>(await tn.get(ks.groupMeta(gid)));
        if (!g || g.s !== "completed") return false;
        const nextAt = now + FINISHED_CONTROL_RECHECK_MS;
        const nextGeneration = randomUUID();
        tn.set(
          ks.groupMeta(gid),
          encodeJson({ ...g, x: nextAt, eg: nextGeneration }),
        );
        tn.clear(expiryKey);
        tn.set(ks.groupExpiry(nextAt, gid, nextGeneration), EMPTY);
        return true;
      });
      if (deferred) return;
    }

    const gcStartedAt = Date.now();
    while (true) {
      await this.renewClaim(claim);
      const result = await this.db.doTn(async tn => {
        await this.guardClaim(tn, claim);
        const jr = ks.groupJobRange(gid);
        const cursor = await tn.get(ks.groupGcCursor(gid));
        const members = await tn
          .snapshot()
          .getRangeAll(cursor ? keyAfter(cursor) : jr.begin, jr.end, {
            limit: GROUP_GC_BATCH,
          });
        for (const [memberKey] of members) {
          const id = ks.unpackId(memberKey as Buffer);
          deleteJobRecords(tn, ks, id);
          await alignQueueMetricStatus(tn, ks, id);
          tn.clear(memberKey as Buffer);
        }
        const exhausted = members.length < GROUP_GC_BATCH;
        if (exhausted) {
          tn.clear(ks.groupGcCursor(gid));
        } else {
          tn.set(
            ks.groupGcCursor(gid),
            members[members.length - 1][0] as Buffer,
          );
        }
        return { exhausted, count: members.length };
      });
      if (result.exhausted) break;
      if (result.count === 0) return;
      if (Date.now() - gcStartedAt >= PARTITION_WORK_BUDGET_MS) return;
    }

    await this.renewClaim(claim);
    await this.db.doTn(async tn => {
      await this.guardClaim(tn, claim);
      const g = decodeJson<GroupMeta>(await tn.get(ks.groupMeta(gid)));
      if (!g || g.s !== "completed") {
        tn.clear(expiryKey);
        return;
      }
      const fjobBuf = await tn.get(ks.groupFinishedJob(gid));
      if (fjobBuf && finishedKs) {
        const fid = fjobBuf.toString("utf8");
        const status = decodeJson<JobStatusRecord>(
          await tn.get(finishedKs.jobStatus(fid)),
        );
        if (status?.s === "queued" || status?.s === "active") return;
        deleteJobRecords(tn, finishedKs, fid);
        await alignQueueMetricStatus(tn, finishedKs, fid);
      }
      const groupRange = ks.groupRange(gid);
      tn.clearRange(groupRange.begin, groupRange.end);
      tn.clear(ks.ongoingGroup(g.o, gid));
      tn.clear(ks.taskGroupFinish(gid));
      tn.clear(ks.taskGroupCancel(gid));
      tn.clear(expiryKey);
    });
  }

  private async indexLegacyActiveGroups(
    queue: NuQFdbQueue,
    claim: PartitionClaim,
  ): Promise<void> {
    if (!queue.groupOps) return;
    await this.renewClaim(claim);
    const ks = queue.ks;
    await this.db.doTn(async tn => {
      await this.guardClaim(tn, claim);
      const range = ks.ongoingGroupAllRange();
      const cursorKey = ks.sweeperCursor(claim.phase, claim.partition);
      const cursor = await tn.get(cursorKey);
      if (cursor?.equals(range.end)) return;
      const rows = await tn
        .snapshot()
        .getRangeAll(cursor ? keyAfter(cursor) : range.begin, range.end, {
          limit: SWEEP_BATCH,
        });
      if (rows.length === 0) {
        tn.set(cursorKey, range.end);
        return;
      }
      const now = Date.now();
      for (const [key] of rows) {
        const gid = ks.unpackId(key as Buffer);
        const group = decodeJson<GroupMeta>(await tn.get(ks.groupMeta(gid)));
        if (!group || group.s !== "active") {
          tn.clear(key as Buffer);
          continue;
        }
        if (group.a !== undefined && group.eg) continue;
        const naturalDeadline = group.c + ACTIVE_GROUP_MAX_AGE_MS;
        const deadline = naturalDeadline <= now ? now - 1 : naturalDeadline;
        const generation = randomUUID();
        tn.set(
          ks.groupMeta(gid),
          encodeJson({ ...group, a: deadline, eg: generation }),
        );
        tn.set(ks.groupExpiry(deadline, gid, generation), EMPTY);
      }
      tn.set(cursorKey, rows[rows.length - 1][0] as Buffer);
    });
  }

  private async indexLegacyGroups(
    queue: NuQFdbQueue,
    claim: PartitionClaim,
  ): Promise<void> {
    if (!queue.groupOps) return;
    await this.renewClaim(claim);
    const ks = queue.ks;
    await this.db.doTn(async tn => {
      await this.guardClaim(tn, claim);
      const range = ks.groupAllRange();
      const cursorKey = ks.sweeperCursor(claim.phase, claim.partition);
      const cursor = await tn.get(cursorKey);
      if (cursor?.equals(range.end)) return;
      const rows = await tn
        .snapshot()
        .getRangeAll(cursor ? keyAfter(cursor) : range.begin, range.end, {
          limit: SWEEP_BATCH * 2,
        });
      if (rows.length === 0) {
        tn.set(cursorKey, range.end);
        return;
      }
      const now = Date.now();
      for (const [key] of rows) {
        let parts: unknown[];
        try {
          // groupDone uses a raw versionstamp suffix and is intentionally not
          // a complete tuple key.
          parts = ks.unpack(key as Buffer);
        } catch {
          continue;
        }
        if (parts[4] !== "meta") continue;
        const gid = String(parts[3]);
        const group = decodeJson<GroupMeta>(await tn.get(ks.groupMeta(gid)));
        if (!group || group.eg) continue;
        let deadline: number | undefined;
        if (group.s === "completed") {
          deadline = group.x;
        } else {
          const naturalDeadline = group.c + ACTIVE_GROUP_MAX_AGE_MS;
          deadline = naturalDeadline <= now ? now - 1 : naturalDeadline;
        }
        if (deadline === undefined) continue;
        const generation = randomUUID();
        tn.set(
          ks.groupMeta(gid),
          encodeJson({
            ...group,
            ...(group.s === "completed" ? { x: deadline } : { a: deadline }),
            eg: generation,
          }),
        );
        tn.set(ks.groupExpiry(deadline, gid, generation), EMPTY);
      }
      tn.set(cursorKey, rows[rows.length - 1][0] as Buffer);
    });
  }

  private async indexLegacyLedgers(
    queue: NuQFdbQueue,
    kind: "team" | "key",
    claim: PartitionClaim,
  ): Promise<void> {
    await this.renewClaim(claim);
    const ks = queue.ks;
    await this.db.doTn(async tn => {
      await this.guardClaim(tn, claim);
      const range = kind === "team" ? ks.teamRange() : ks.keyGateRange();
      const cursorKey = ks.sweeperCursor(claim.phase, claim.partition);
      const cursor = await tn.get(cursorKey);
      if (cursor?.equals(range.end)) return;
      const rows = await tn
        .snapshot()
        .getRangeAll(cursor ? keyAfter(cursor) : range.begin, range.end, {
          limit: SWEEP_BATCH * 2,
        });
      if (rows.length === 0) {
        tn.set(cursorKey, range.end);
        return;
      }
      const ids = new Set<string>();
      for (const [key] of rows) {
        const parts = ks.unpack(key as Buffer);
        if (typeof parts[3] === "string") ids.add(parts[3]);
      }
      for (const id of ids) {
        if (kind === "team") {
          // This range is also the aggregate-count index, so initialize it
          // from the authoritative ledger under a normal read conflict.
          const active = decodeI64(await tn.get(ks.teamActive(id)));
          tn.set(ks.teamActiveIndex(id), encodeI64(active));
          tn.set(ks.teamLedgerGcIndex(id), EMPTY);
        } else {
          tn.set(ks.keyLedgerIndex(id), EMPTY);
        }
      }
      tn.set(cursorKey, rows[rows.length - 1][0] as Buffer);
    });
  }

  private async sweepLedgers(
    queue: NuQFdbQueue,
    kind: "team" | "key",
    bucket: number,
    claim: PartitionClaim,
  ): Promise<void> {
    const ks = queue.ks;
    const range =
      kind === "team"
        ? ks.teamLedgerGcIndexRange(bucket)
        : ks.keyLedgerIndexRange(bucket);
    // Persistent live-ledger markers are expected. Process one cursor page per
    // tick so an exact full page cannot wrap and hot-loop over the same rows.
    const rows = await this.taskBatch(claim, range, SWEEP_BATCH);
    for (const [indexKey] of rows) {
      const id = ks.unpackId(indexKey);
      await this.renewClaim(claim);
      await this.db.doTn(async tn => {
        await this.guardClaim(tn, claim);
        const active = decodeI64(
          await tn.get(kind === "team" ? ks.teamActive(id) : ks.keyActive(id)),
        );
        const pending = decodeI64(
          await tn.get(
            kind === "team" ? ks.teamPendingCount(id) : ks.keyPendingCount(id),
          ),
        );
        const reserved =
          kind === "team"
            ? decodeI64(await tn.get(ks.teamIngestReserved(id)))
            : 0;
        if (active > 0 || pending > 0 || reserved > 0) return;
        // Delayed and crawl-pending work intentionally holds neither an
        // active nor a pending slot at the inner gates. Keep the cold limit
        // key so such latent work cannot wake up to Infinity; collect the
        // zero/historical mutable ledger and its discovery markers.
        if (kind === "team") {
          tn.clear(ks.teamActive(id));
          tn.clear(ks.teamPendingCount(id));
          tn.clear(ks.teamIngestReserved(id));
          const shards = ks.teamShardCountRange(id);
          tn.clearRange(shards.begin, shards.end);
          tn.clear(ks.teamActiveIndex(id));
        } else {
          tn.clear(ks.keyActive(id));
          tn.clear(ks.keyPendingCount(id));
        }
        tn.clear(indexKey);
      });
    }
  }
}
