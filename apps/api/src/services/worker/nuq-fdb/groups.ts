import { randomUUID } from "crypto";
import type { Transaction } from "foundationdb";
import { Logger } from "winston";
import { logger as _logger } from "../../../lib/logger";
import { getNuqFdbDatabase } from "./client";
import {
  NuqFdbKeyspace,
  GroupMeta,
  JobMeta,
  QueueEntry,
  encodeJson,
  decodeJson,
  decodeI64,
  normalizeOwnerId,
} from "./keyspace";
import {
  ONE,
  MINUS_ONE,
  EMPTY,
  TxContext,
  newTxContext,
  uvSuffix,
  pushReady,
  setStatusQueued,
  setGroupJobIndex,
  bumpGroupStatusCount,
  alignQueueMetricStatus,
  reconcileJobMigrationInTxn,
  runtimeMigrationPin,
  stampMigrationPin,
} from "./ops";
import {
  MigrationCorruptionError,
  MigrationStoreError,
  nuqFdbMigrationStore,
} from "./migration-store";

export type NuQFdbGroupStatus = "active" | "completed" | "cancelled";

export type NuQFdbJobGroupInstance = {
  id: string;
  status: NuQFdbGroupStatus;
  createdAt: Date;
  ownerId: string;
  ttl: number;
  expiresAt?: Date;
  maxConcurrency?: number;
  delaySeconds?: number;
  migrationBackend?: "pg" | "fdb";
  migrationGeneration?: number;
};

const DEFAULT_GROUP_TTL_MS = 86400000;
// A group that is never populated, abandoned by its producer, or otherwise
// never reaches normal completion must not live forever. This deadline is
// independent of the post-completion retention TTL.
export const ACTIVE_GROUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGACY_GROUP_OWNER_INDEX_PHASE =
  "migration-legacy-group-owner-index-v1";

export function groupSweepTaskId(gid: string): string {
  return `group-cancel/${gid}`;
}

export async function prepareGroupSweepTaskInTxn(
  tn: Transaction,
  gid: string,
  group: GroupMeta,
): Promise<import("./migration-store").MigrationObjectPin | null> {
  const groupPin = await nuqFdbMigrationStore.validateManagedObjectInTxn(tn, {
    teamId: group.o,
    kind: "group",
    objectId: gid,
    recordPin: runtimeMigrationPin(group),
    legacyResidue: { control_groups: 1 },
  });
  if (!groupPin) return null;
  const taskPin = await nuqFdbMigrationStore.preparePinnedObjectInTxn(tn, {
    teamId: group.o,
    kind: "sweeper_task",
    objectId: groupSweepTaskId(gid),
    admission: {
      type: "pinned-continuation",
      source: { kind: "group", objectId: gid },
    },
    requiredBackend: "fdb",
    residue: { control_sweeper_tasks: 1 },
  });
  return await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
    teamId: group.o,
    kind: "sweeper_task",
    objectId: groupSweepTaskId(gid),
    recordPin: {
      backend: taskPin.backend,
      generation: taskPin.generation,
    },
    residue: { control_sweeper_tasks: 1 },
  });
}

export class NuqFdbGroupOps {
  constructor(
    public readonly ks: NuqFdbKeyspace,
    public readonly finishedKs: NuqFdbKeyspace | null,
  ) {}

  // Group accounting for a job reaching a terminal state. Must run in the same
  // transaction as the status transition. The blind task-key set is the
  // race-free backstop for finish detection; the inline completion attempt
  // covers the common small-crawl case instantly.
  public async terminalAccounting(
    tn: Transaction,
    gid: string,
    id: string,
    prevStatus: string,
    outcome: "completed" | "failed",
    countable: boolean,
    now: number,
    txc: TxContext,
  ): Promise<void> {
    setGroupJobIndex(tn, this.ks, gid, id, countable, outcome);
    if (countable) {
      bumpGroupStatusCount(tn, this.ks, gid, prevStatus, -1);
      bumpGroupStatusCount(tn, this.ks, gid, outcome, 1);
      if (outcome === "completed") {
        tn.setVersionstampSuffixedKey(
          this.ks.groupDonePrefix(gid),
          Buffer.from(id, "utf8"),
          uvSuffix(txc),
        );
      }
    }

    const remSnap = decodeI64(
      await tn.snapshot().get(this.ks.groupRemaining(gid)),
    );
    tn.set(this.ks.taskGroupFinish(gid), EMPTY);
    if (remSnap <= 5) {
      // near the end: read for real (conflicts with concurrent finishers, but
      // contention is bounded to the last few jobs of the group)
      const remReal = decodeI64(await tn.get(this.ks.groupRemaining(gid)));
      tn.add(this.ks.groupRemaining(gid), MINUS_ONE);
      if (remReal - 1 <= 0) {
        await this.tryCompleteGroup(tn, gid, now, txc);
      }
    } else {
      tn.add(this.ks.groupRemaining(gid), MINUS_ONE);
    }
  }

  // Completes a drained group: flips status, schedules TTL cleanup, and emits
  // the crawl-finished job. The normal read of group meta serializes
  // concurrent completers; exactly one transaction performs the emit.
  public async tryCompleteGroup(
    tn: Transaction,
    gid: string,
    now: number,
    txc: TxContext,
  ): Promise<boolean> {
    // A multi-transaction enqueue holds this barrier from reservation through
    // its final publish, so an empty prefix of the batch cannot finish the
    // group while later chunks are still invisible.
    const ingests = decodeI64(await tn.get(this.ks.groupIngestCount(gid)));
    if (ingests > 0) return false;
    const gMeta = decodeJson<GroupMeta>(await tn.get(this.ks.groupMeta(gid)));
    if (!gMeta || gMeta.s === "completed") {
      tn.clear(this.ks.taskGroupFinish(gid));
      return false;
    }
    const continuationPin =
      gMeta.s === "cancelled"
        ? await nuqFdbMigrationStore.validateManagedObjectInTxn(tn, {
            teamId: gMeta.o,
            kind: "sweeper_task",
            objectId: groupSweepTaskId(gid),
            recordPin: runtimeMigrationPin(gMeta),
            legacyResidue: { control_sweeper_tasks: 1 },
          })
        : await nuqFdbMigrationStore.validateManagedObjectInTxn(tn, {
            teamId: gMeta.o,
            kind: "group",
            objectId: gid,
            recordPin: runtimeMigrationPin(gMeta),
            legacyResidue: { control_groups: 1 },
          });
    const expiresAt = now + gMeta.t;
    const expiryGeneration = randomUUID();
    const updated: GroupMeta = {
      ...gMeta,
      s: "completed",
      x: expiresAt,
      eg: expiryGeneration,
    };
    tn.set(this.ks.groupMeta(gid), encodeJson(updated));
    if (gMeta.a !== undefined && gMeta.eg) {
      tn.clear(this.ks.groupExpiry(gMeta.a, gid, gMeta.eg));
    }
    tn.set(this.ks.groupExpiry(expiresAt, gid, expiryGeneration), EMPTY);
    tn.clear(this.ks.ongoingGroup(gMeta.o, gid));
    tn.clear(this.ks.taskGroupFinish(gid));

    if (this.finishedKs) {
      const fid = randomUUID();
      const finishedPin = continuationPin
        ? await nuqFdbMigrationStore.preparePinnedObjectInTxn(tn, {
            teamId: gMeta.o,
            kind: "crawl_finished",
            objectId: fid,
            admission: {
              type: "pinned-continuation",
              source: {
                kind: gMeta.s === "cancelled" ? "sweeper_task" : "group",
                objectId: gMeta.s === "cancelled" ? groupSweepTaskId(gid) : gid,
              },
            },
            requiredBackend: "fdb",
            residue: { control_crawl_finished: 1 },
          })
        : null;
      const meta: JobMeta = stampMigrationPin(
        { c: now, p: 0, o: gMeta.o, g: gid, f: 0, dc: 1 },
        finishedPin,
      );
      tn.set(this.finishedKs.jobMeta(fid), encodeJson(meta));
      tn.set(this.finishedKs.jobData(fid, 0), encodeJson({}));
      const entry: QueueEntry = stampMigrationPin(
        {
          i: fid,
          o: gMeta.o,
          g: gid,
          p: 0,
          f: 0,
          c: now,
        },
        finishedPin,
      );
      pushReady(tn, this.finishedKs, entry, txc);
      await reconcileJobMigrationInTxn(tn, this.finishedKs, entry, {
        control_crawl_finished: 1,
      });
      setStatusQueued(tn, this.finishedKs, fid);
      await alignQueueMetricStatus(tn, this.finishedKs, fid);
      // pointer for group TTL cleanup to find the finished job's records
      tn.set(this.ks.groupFinishedJob(gid), Buffer.from(fid, "utf8"));
    }
    if (gMeta.s === "cancelled") {
      // A router from an earlier rollout may have adopted the group before
      // publishing its continuation in a second transaction. Retire any such
      // live group pin in this completion transaction so the race cannot leave
      // permanent source residue.
      const groupPin = await nuqFdbMigrationStore.inspectPinInTxn(
        tn,
        "group",
        gid,
      );
      if (groupPin && groupPin.lifecycle !== "terminal") {
        await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
          teamId: gMeta.o,
          kind: "group",
          objectId: gid,
          recordPin: runtimeMigrationPin(gMeta),
          residue: {},
          terminal: true,
        });
      }
      await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
        teamId: gMeta.o,
        kind: "sweeper_task",
        objectId: groupSweepTaskId(gid),
        recordPin: runtimeMigrationPin(gMeta),
        residue: {},
        terminal: true,
      });
    } else {
      await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
        teamId: gMeta.o,
        kind: "group",
        objectId: gid,
        recordPin: runtimeMigrationPin(gMeta),
        residue: {},
        terminal: true,
      });
    }
    return true;
  }
}

export class NuQFdbJobGroup {
  constructor(
    public readonly ks: NuqFdbKeyspace,
    public readonly groupOps: NuqFdbGroupOps,
  ) {}

  private get db() {
    return getNuqFdbDatabase();
  }

  private toInstance(id: string, g: GroupMeta): NuQFdbJobGroupInstance {
    return {
      id,
      status: g.s,
      createdAt: new Date(g.c),
      ownerId: g.o,
      ttl: g.t,
      expiresAt: g.x !== undefined ? new Date(g.x) : undefined,
      maxConcurrency: g.m,
      delaySeconds: g.d,
      migrationBackend: g.mb,
      migrationGeneration: g.mg,
    };
  }

  public async addGroup(
    id: string,
    ownerId: string,
    ttl?: number,
    opts?: { maxConcurrency?: number; delaySeconds?: number },
    logger: Logger = _logger,
  ): Promise<NuQFdbJobGroupInstance> {
    const owner = normalizeOwnerId(ownerId);
    if (owner === null) throw new Error("Group owner is required");
    return await this.db.doTn(async tn => {
      const existingBuf = await tn.get(this.ks.groupMeta(id));
      const existing = decodeJson<GroupMeta>(existingBuf);
      if (existing) {
        await nuqFdbMigrationStore.validateManagedObjectInTxn(tn, {
          teamId: owner,
          kind: "group",
          objectId: id,
          recordPin: runtimeMigrationPin(existing),
          legacyResidue: { control_groups: 1 },
        });
        return this.toInstance(id, existing);
      }
      const now = Date.now();
      const abandonmentDeadline = now + ACTIVE_GROUP_MAX_AGE_MS;
      const expiryGeneration = randomUUID();
      const pin = await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
        teamId: owner,
        kind: "group",
        objectId: id,
        allowMissingRecordPin: true,
        residue: { control_groups: 1 },
      });
      const g: GroupMeta = stampMigrationPin(
        {
          o: owner,
          c: now,
          t: ttl ?? DEFAULT_GROUP_TTL_MS,
          s: "active",
          m: opts?.maxConcurrency,
          d: opts?.delaySeconds,
          a: abandonmentDeadline,
          eg: expiryGeneration,
        },
        pin,
      );
      tn.set(this.ks.groupMeta(id), encodeJson(g));
      tn.set(
        this.ks.groupExpiry(abandonmentDeadline, id, expiryGeneration),
        EMPTY,
      );
      tn.set(this.ks.ongoingGroup(owner, id), encodeJson({ c: now }));
      return this.toInstance(id, g);
    });
  }

  public async getGroup(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQFdbJobGroupInstance | null> {
    return await this.db.doTn(async tn => {
      const g = decodeJson<GroupMeta>(await tn.get(this.ks.groupMeta(id)));
      return g ? this.toInstance(id, g) : null;
    });
  }

  /** Advances the bounded deployment backfill that restores owner rows cleared
   * by pre-hook cancellation code. Migration discovery fails closed until the
   * global scan reaches its durable completion cursor. */
  public async backfillLegacyOwnerIndex(batchSize = 500): Promise<boolean> {
    const pageSize = Math.max(1, batchSize);
    return await this.db.doTn(async tn => {
      const control = decodeJson<{ generation: string; phase: string }>(
        await tn.get(this.ks.metricControl()),
      );
      if (!control?.generation || control.phase !== "ready") {
        throw new MigrationStoreError(
          "NUQ_FDB_GROUP_OWNER_INDEX_NOT_READY",
          "group owner backfill requires a ready metric generation",
          true,
        );
      }
      const range = this.ks.groupAllRange();
      const cursorKey = this.ks.sweeperCursor(
        `${LEGACY_GROUP_OWNER_INDEX_PHASE}/${control.generation}`,
        0,
      );
      const cursor = await tn.get(cursorKey);
      if (cursor?.equals(range.end)) return true;
      const begin = cursor
        ? Buffer.concat([cursor as Buffer, Buffer.from([0])])
        : range.begin;
      const rows = await tn.getRangeAll(begin, range.end, { limit: pageSize });
      for (const [key, value] of rows) {
        let parts: unknown[];
        try {
          // groupDone carries a raw versionstamp suffix, not a complete tuple.
          parts = this.ks.unpack(key as Buffer);
        } catch {
          continue;
        }
        if (parts[parts.length - 1] !== "meta") continue;
        const group = decodeJson<GroupMeta>(value as Buffer);
        if (!group || (group.s !== "active" && group.s !== "cancelled")) {
          continue;
        }
        const gid = String(parts[parts.length - 2]);
        tn.set(this.ks.ongoingGroup(group.o, gid), encodeJson({ c: group.c }));
      }
      if (rows.length < pageSize) {
        tn.set(cursorKey, range.end);
        return true;
      }
      tn.set(cursorKey, rows[rows.length - 1][0] as Buffer);
      return false;
    });
  }

  public async hasUnfinishedByOwner(ownerId: string): Promise<boolean> {
    const owner = normalizeOwnerId(ownerId);
    if (owner === null) return false;
    return await this.db.doTn(async tn => {
      const range = this.ks.ongoingGroupRange(owner);
      const rows = await tn.getRangeAll(range.begin, range.end);
      for (const [key] of rows) {
        const gid = this.ks.unpackId(key as Buffer);
        const group = decodeJson<GroupMeta>(
          await tn.get(this.ks.groupMeta(gid)),
        );
        if (group?.s === "active" || group?.s === "cancelled") {
          if (group.o !== owner) {
            throw new MigrationCorruptionError(
              `group owner index ${owner}/${gid}`,
              "live group owner mismatch",
            );
          }
          return true;
        }
        tn.clear(key as Buffer);
      }
      const control = decodeJson<{ generation: string; phase: string }>(
        await tn.get(this.ks.metricControl()),
      );
      const all = this.ks.groupAllRange();
      const cursor = control?.generation
        ? await tn.get(
            this.ks.sweeperCursor(
              `${LEGACY_GROUP_OWNER_INDEX_PHASE}/${control.generation}`,
              0,
            ),
          )
        : null;
      if (control?.phase !== "ready" || !cursor?.equals(all.end)) {
        throw new MigrationStoreError(
          "NUQ_FDB_GROUP_OWNER_INDEX_NOT_READY",
          "legacy group owner index backfill is not complete",
          true,
        );
      }
      return false;
    });
  }

  /** Restores the owner-discovery row cleared by pre-hook cancellation code. */
  public async restoreLegacyCancelledGroupOwnerIndex(
    id: string,
  ): Promise<boolean> {
    return await this.db.doTn(async tn => {
      const group = decodeJson<GroupMeta>(await tn.get(this.ks.groupMeta(id)));
      if (!group || group.s !== "cancelled") return false;
      tn.set(this.ks.ongoingGroup(group.o, id), encodeJson({ c: group.c }));
      return true;
    });
  }

  public async getOngoingByOwner(
    ownerId: string,
    logger: Logger = _logger,
  ): Promise<NuQFdbJobGroupInstance[]> {
    const owner = normalizeOwnerId(ownerId);
    if (owner === null) return [];
    return await this.db.doTn(async tn => {
      const r = this.ks.ongoingGroupRange(owner);
      const rows = await tn.getRangeAll(r.begin, r.end);
      const out: NuQFdbJobGroupInstance[] = [];
      for (const [key] of rows) {
        const gid = this.ks.unpackId(key as Buffer);
        const g = decodeJson<GroupMeta>(await tn.get(this.ks.groupMeta(gid)));
        if (g && (g.s === "active" || g.s === "cancelled")) {
          if (g.o !== owner) {
            throw new MigrationCorruptionError(
              `group owner index ${owner}/${gid}`,
              "live group owner mismatch",
            );
          }
          if (g.s === "active") out.push(this.toInstance(gid, g));
        } else if (!g || g.s === "completed") {
          tn.clear(key as Buffer);
        }
      }
      return out;
    });
  }

  /** Adopts cancellation work written before migration hooks. The legacy
   * group pin becomes terminal only after an active sweeper continuation is
   * established in the same transaction. */
  public async adoptLegacyCancelledGroup(id: string): Promise<boolean> {
    return await this.db.doTn(async tn => {
      const group = decodeJson<GroupMeta>(await tn.get(this.ks.groupMeta(id)));
      if (!group || group.s !== "cancelled") return false;
      const groupPin =
        (await nuqFdbMigrationStore.inspectPinInTxn(tn, "group", id)) ??
        (await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
          teamId: group.o,
          kind: "group",
          objectId: id,
          residue: { control_groups: 1 },
          terminal: true,
          cancelledGroupContinuation: true,
          activateNonterminal: false,
        }));
      if (!groupPin) throw new Error(`Legacy group ${id} was not adopted`);
      if (groupPin.lifecycle === "terminal") {
        // Older rollout code could terminalize a cancelled group without first
        // creating its continuation. Repair that state as an explicit legacy
        // task in the same generation while it remains drainable.
        let taskPin = await nuqFdbMigrationStore.inspectPinInTxn(
          tn,
          "sweeper_task",
          groupSweepTaskId(id),
        );
        if (!taskPin) {
          try {
            taskPin = await nuqFdbMigrationStore.preparePinnedObjectInTxn(tn, {
              teamId: group.o,
              kind: "sweeper_task",
              objectId: groupSweepTaskId(id),
              admission: {
                type: "legacy-backfill",
                backend: groupPin.backend,
                generation: groupPin.generation,
              },
              requiredBackend: "fdb",
              residue: { control_sweeper_tasks: 1 },
            });
          } catch (error) {
            if (
              error instanceof MigrationStoreError &&
              error.code === "NUQ_MIGRATION_STALE_GENERATION"
            ) {
              throw new MigrationStoreError(
                "NUQ_MIGRATION_CANCELLED_GROUP_CONTINUATION_LOST",
                `cancelled group ${id} was sealed before its sweeper continuation was recorded`,
              );
            }
            throw error;
          }
          taskPin = await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
            teamId: group.o,
            kind: "sweeper_task",
            objectId: groupSweepTaskId(id),
            recordPin: taskPin,
            residue: { control_sweeper_tasks: 1 },
          });
        } else {
          await nuqFdbMigrationStore.validatePinnedObjectInTxn(tn, {
            teamId: group.o,
            kind: "sweeper_task",
            objectId: groupSweepTaskId(id),
            backend: groupPin.backend,
            generation: groupPin.generation,
          });
        }
        tn.set(this.ks.taskGroupCancel(id), EMPTY);
        tn.set(this.ks.taskGroupFinish(id), EMPTY);
        return taskPin !== null;
      }

      const taskPin = await nuqFdbMigrationStore.inspectPinInTxn(
        tn,
        "sweeper_task",
        groupSweepTaskId(id),
      );
      if (!taskPin) {
        throw new MigrationCorruptionError(
          `cancelled group ${id}`,
          "legacy adoption committed without its sweeper continuation",
        );
      }
      await nuqFdbMigrationStore.validatePinnedObjectInTxn(tn, {
        teamId: group.o,
        kind: "sweeper_task",
        objectId: groupSweepTaskId(id),
        backend: groupPin.backend,
        generation: groupPin.generation,
      });
      await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
        teamId: group.o,
        kind: "group",
        objectId: id,
        recordPin: {
          backend: groupPin.backend,
          generation: groupPin.generation,
        },
        residue: {},
        terminal: true,
      });
      // Backfill the shared generation onto GroupMeta so later sweeper-task
      // validation does not depend on the legacy missing-pin exception.
      tn.set(
        this.ks.groupMeta(id),
        encodeJson(stampMigrationPin(group, groupPin)),
      );
      tn.set(this.ks.taskGroupCancel(id), EMPTY);
      tn.set(this.ks.taskGroupFinish(id), EMPTY);
      return true;
    });
  }

  // O(1) cancellation: flips the group status and leaves the heavy lifting to
  // the sweeper (pending entries) and take-side diversion (ready entries).
  public async cancelGroup(
    id: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    return await this.db.doTn(async tn => {
      const g = decodeJson<GroupMeta>(await tn.get(this.ks.groupMeta(id)));
      if (!g || g.s !== "active") return false;
      await prepareGroupSweepTaskInTxn(tn, id, g);
      await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
        teamId: g.o,
        kind: "group",
        objectId: id,
        recordPin: runtimeMigrationPin(g),
        residue: {},
        terminal: true,
      });
      tn.set(
        this.ks.groupMeta(id),
        encodeJson({ ...g, s: "cancelled" } satisfies GroupMeta),
      );
      tn.set(this.ks.taskGroupCancel(id), EMPTY);
      // Retain the owner index until completion so migration discovery can
      // fence the cancelled group's still-pending sweeper/control work.
      return true;
    });
  }
}
