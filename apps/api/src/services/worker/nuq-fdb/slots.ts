import { randomUUID } from "crypto";
import type { Transaction } from "foundationdb";
import { getNuqFdbDatabase } from "./client";
import {
  NuqFdbKeyspace,
  QueueEntry,
  decodeJson,
  encodeJson,
  timeBucket,
  F_GATED,
  normalizeOwnerId,
} from "./keyspace";
import {
  bumpTeamActive,
  newTxContext,
  releaseSlotsAndPromote,
  runtimeMigrationPin,
  synchronizeTeamLimitInTxn,
  stampMigrationPin,
} from "./ops";
import { nuqFdbMigrationStore } from "./migration-store";

// External slots: capacity consumed by things that are not queue jobs (sync
// scrapes via the team semaphore, browser sessions). They unconditionally bump
// the team active counter -- possibly past the limit, matching the old Redis
// behavior where sync holders were mirrored into the same ZSET -- and hand
// their slot through the normal promotion chain on release.

export type ExternalSlotRecord = {
  e: number; // expiry ms
  g?: string; // renewal generation (absent on pre-generation records)
  mb?: "pg" | "fdb"; // migration backend pin
  mg?: number; // never-reused migration generation
};

type PgExternalSlotExpiryRecord = {
  e: number;
  g: string;
  t: string;
  h: string;
};

export type ExternalSlotSweepGuard = (tn: Transaction) => Promise<void>;
export type ExternalSlotSweepObserver = (
  due: readonly [Buffer, Buffer][],
) => void;

const EXTERNAL_SWEEP_BATCH = 100;
const EXTERNAL_SWEEP_BUDGET_MS = 5_000;

// Holder IDs are tenant-local; migration pins live in a global object keyspace.
export function externalSlotMigrationObjectId(
  teamId: string,
  holderId: string,
): string {
  return `${teamId}/${holderId}`;
}

export class NuqFdbExternalSlots {
  constructor(public readonly ks: NuqFdbKeyspace) {}

  private get db() {
    return getNuqFdbDatabase();
  }

  private key(teamId: string, holderId: string): Buffer {
    return this.ks.pack(["xs", teamId, holderId]);
  }

  private expiryKey(
    bucket: number,
    expMs: number,
    teamId: string,
    holderId: string,
    generation: string,
  ): Buffer {
    // Team is part of the identity: holder ids are only tenant-local.
    return this.ks.pack(["xsexp", bucket, expMs, teamId, holderId, generation]);
  }

  private legacyExpiryKey(
    bucket: number,
    expMs: number,
    holderId: string,
  ): Buffer {
    return this.ks.pack(["xsexp", bucket, expMs, holderId]);
  }

  private pgExpiryRecordKey(teamId: string, holderId: string): Buffer {
    return this.ks.pack(["pgxs", teamId, holderId]);
  }

  private pgExpiryKey(
    bucket: number,
    expMs: number,
    teamId: string,
    holderId: string,
    generation: string,
  ): Buffer {
    return this.ks.pack([
      "pgxsexp",
      bucket,
      expMs,
      teamId,
      holderId,
      generation,
    ]);
  }

  public expiryScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.ks.pack(["xsexp", bucket]),
      end: this.ks.pack(["xsexp", bucket, untilMs]),
    };
  }

  public pgExpiryScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.ks.pack(["pgxsexp", bucket]),
      end: this.ks.pack(["pgxsexp", bucket, untilMs]),
    };
  }

  public async has(teamId: string, holderId: string): Promise<boolean> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return false;
    return await this.db.doTn(async tn =>
      Boolean(await tn.snapshot().get(this.key(owner, holderId))),
    );
  }

  /** Conflict-safe point reads used by migration tombstone GC. The durable PG
   * expiry intent remains authoritative when Redis has been flushed. */
  public async hasMigrationReferenceInTxn(
    tn: Transaction,
    teamId: string,
    holderId: string,
  ): Promise<boolean> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return false;
    const [fdb, pg] = await Promise.all([
      tn.get(this.key(owner, holderId)),
      tn.get(this.pgExpiryRecordKey(owner, holderId)),
    ]);
    return Boolean(fdb || pg);
  }

  private async acquireInTxn(
    tn: Transaction,
    owner: string,
    holderId: string,
    ttlMs: number,
    limit: number | null,
    prepareMigrationPin: boolean,
    requireExisting: boolean,
  ): Promise<boolean> {
    const existing = decodeJson<ExternalSlotRecord>(
      await tn.get(this.key(owner, holderId)),
    );

    if (!existing && requireExisting) return false;

    // A non-snapshot read conflicts with every queue/external active-count
    // mutation. The capacity check and holder insertion therefore serialize in
    // FDB instead of relying on a process lock or a second Redis ledger. A
    // capacity-aware reservation carries the caller's current configured limit;
    // renew-only heartbeats pass no limit and therefore cannot overwrite it.
    const active =
      limit !== null
        ? await synchronizeTeamLimitInTxn(tn, this.ks, owner, limit)
        : null;
    if (!existing && limit !== null && active !== null && active >= limit) {
      return false;
    }

    const objectId = externalSlotMigrationObjectId(owner, holderId);
    if (!existing && prepareMigrationPin) {
      await nuqFdbMigrationStore.preparePinnedObjectInTxn(tn, {
        teamId: owner,
        kind: "external_holder",
        objectId,
        admission: { type: "new-root" },
        requiredBackend: "fdb",
        residue: { capacity_external_holders: 1 },
      });
    }

    const pin = await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
      teamId: owner,
      kind: "external_holder",
      objectId,
      ...(existing
        ? { recordPin: runtimeMigrationPin(existing) }
        : { allowMissingRecordPin: true }),
      residue: { capacity_external_holders: 1 },
    });

    if (existing) {
      tn.clear(
        existing.g
          ? this.expiryKey(
              timeBucket(`${owner}/${holderId}`),
              existing.e,
              owner,
              holderId,
              existing.g,
            )
          : this.legacyExpiryKey(timeBucket(holderId), existing.e, holderId),
      );
    } else {
      bumpTeamActive(tn, this.ks, owner, 1);
    }

    const exp = Date.now() + ttlMs;
    const generation = randomUUID();
    const record = stampMigrationPin(
      { e: exp, g: generation } satisfies ExternalSlotRecord,
      pin,
    );
    tn.set(this.key(owner, holderId), encodeJson(record));
    tn.set(
      this.expiryKey(
        timeBucket(`${owner}/${holderId}`),
        exp,
        owner,
        holderId,
        generation,
      ),
      Buffer.alloc(0),
    );
    return true;
  }

  // Acquires (or renews) an external slot unconditionally. Router-owned new
  // holders prepare their migration pin in this same transaction.
  public async acquire(
    teamId: string,
    holderId: string,
    ttlMs: number,
    options?: { prepareMigrationPin?: boolean },
  ): Promise<void> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return;
    await this.db.doTn(async tn => {
      await this.acquireInTxn(
        tn,
        owner,
        holderId,
        ttlMs,
        null,
        options?.prepareMigrationPin === true,
        false,
      );
    });
  }

  // PG holders live in Redis, but their migration residue cannot depend on a
  // volatile Redis TTL. Publish the exact renewal generation into FDB and
  // activate the pin atomically with that expiry record.
  public async renewPg(
    teamId: string,
    holderId: string,
    expiresAt: number,
    options?: { prepareMigrationPin?: boolean },
  ): Promise<void> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new TypeError("external holder expiry must be a safe integer");
    }
    const generation = randomUUID();
    const objectId = externalSlotMigrationObjectId(owner, holderId);
    await this.db.doTn(async tn => {
      let pin = await nuqFdbMigrationStore.inspectPinInTxn(
        tn,
        "external_holder",
        objectId,
      );
      if (!pin && options?.prepareMigrationPin) {
        pin = await nuqFdbMigrationStore.preparePinnedObjectInTxn(tn, {
          teamId: owner,
          kind: "external_holder",
          objectId,
          admission: { type: "new-root" },
          requiredBackend: "pg",
          residue: { intent_unresolved: 1 },
        });
      } else {
        pin = await nuqFdbMigrationStore.validatePinnedObjectInTxn(tn, {
          teamId: owner,
          kind: "external_holder",
          objectId,
          backend: "pg",
        });
      }
      const prior = decodeJson<PgExternalSlotExpiryRecord>(
        await tn.get(this.pgExpiryRecordKey(owner, holderId)),
      );
      if (prior) {
        tn.clear(
          this.pgExpiryKey(
            timeBucket(`${owner}/${holderId}`),
            prior.e,
            owner,
            holderId,
            prior.g,
          ),
        );
      }
      if (pin.lifecycle === "prepared") {
        await nuqFdbMigrationStore.transitionObjectResidueInTxn(tn, {
          teamId: owner,
          kind: "external_holder",
          objectId,
          operationId: `nuq-router/v1/external-holder-active/${objectId}`,
          fromLifecycle: "prepared",
          toLifecycle: "active",
          residue: { capacity_external_holders: 1 },
        });
      }
      const record: PgExternalSlotExpiryRecord = {
        e: expiresAt,
        g: generation,
        t: owner,
        h: holderId,
      };
      tn.set(this.pgExpiryRecordKey(owner, holderId), encodeJson(record));
      tn.set(
        this.pgExpiryKey(
          timeBucket(`${owner}/${holderId}`),
          expiresAt,
          owner,
          holderId,
          generation,
        ),
        Buffer.alloc(0),
      );
    });
  }

  public async releasePg(teamId: string, holderId: string): Promise<void> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return;
    const objectId = externalSlotMigrationObjectId(owner, holderId);
    await this.db.doTn(async tn => {
      const prior = decodeJson<PgExternalSlotExpiryRecord>(
        await tn.get(this.pgExpiryRecordKey(owner, holderId)),
      );
      if (prior) {
        tn.clear(
          this.pgExpiryKey(
            timeBucket(`${owner}/${holderId}`),
            prior.e,
            owner,
            holderId,
            prior.g,
          ),
        );
        tn.clear(this.pgExpiryRecordKey(owner, holderId));
      }
      const pin = await nuqFdbMigrationStore.inspectPinInTxn(
        tn,
        "external_holder",
        objectId,
      );
      if (!pin || pin.lifecycle === "terminal") return;
      if (pin.teamId !== owner || pin.backend !== "pg") {
        throw new Error(`PG external holder pin mismatch for ${objectId}`);
      }
      await nuqFdbMigrationStore.completePinnedObjectInTxn(tn, {
        teamId: owner,
        kind: "external_holder",
        objectId,
        operationId: `nuq-router/v1/external-holder-terminal/${objectId}`,
        fromLifecycle: pin.lifecycle,
      });
    });
  }

  // Atomically checks authoritative team occupancy and inserts the holder.
  // Re-acquiring an existing holder only renews it and never double-counts.
  public async reserve(
    teamId: string,
    holderId: string,
    ttlMs: number,
    limit: number,
    options?: { prepareMigrationPin?: boolean },
  ): Promise<boolean> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return false;
    return await this.db.doTn(async tn =>
      this.acquireInTxn(
        tn,
        owner,
        holderId,
        ttlMs,
        limit,
        options?.prepareMigrationPin === true,
        false,
      ),
    );
  }

  // Renews an existing holder without changing the configured team limit or
  // resurrecting a holder that expiry cleanup has already released.
  public async renew(
    teamId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<boolean> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return false;
    return await this.db.doTn(async tn =>
      this.acquireInTxn(tn, owner, holderId, ttlMs, null, false, true),
    );
  }

  // Releases the slot, handing it to a pending job when one exists.
  public async release(teamId: string, holderId: string): Promise<void> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return;
    await this.db.doTn(async tn => {
      await this.releaseInTxn(tn, owner, holderId);
    });
  }

  public async releaseInTxn(
    tn: Transaction,
    owner: string,
    holderId: string,
  ): Promise<boolean> {
    const existing = decodeJson<ExternalSlotRecord>(
      await tn.get(this.key(owner, holderId)),
    );
    if (!existing) return false;
    await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
      teamId: owner,
      kind: "external_holder",
      objectId: externalSlotMigrationObjectId(owner, holderId),
      recordPin: runtimeMigrationPin(existing),
      residue: {},
      terminal: true,
    });
    tn.clear(this.key(owner, holderId));
    tn.clear(
      existing.g
        ? this.expiryKey(
            timeBucket(`${owner}/${holderId}`),
            existing.e,
            owner,
            holderId,
            existing.g,
          )
        : this.legacyExpiryKey(timeBucket(holderId), existing.e, holderId),
    );
    const entry: QueueEntry = {
      i: holderId,
      o: owner,
      p: 0,
      f: F_GATED,
      c: 0,
    };
    await releaseSlotsAndPromote(
      tn,
      this.ks,
      entry,
      { team: true, key: false, crawl: false },
      Date.now(),
      newTxContext(),
    );
    return true;
  }

  // Sweeper hook for one independently-owned time bucket. It drains due rows
  // with bounded pagination rather than imposing a fixed per-pass ceiling.
  public async sweepExpiredBucket(
    now: number,
    bucket: number,
    guard?: ExternalSlotSweepGuard,
    observeDue?: ExternalSlotSweepObserver,
  ): Promise<number> {
    const startedAt = Date.now();
    let processed = 0;
    while (Date.now() - startedAt < EXTERNAL_SWEEP_BUDGET_MS) {
      const r = this.expiryScanRange(bucket, now);
      const due = (await this.db.doTn(async tn => {
        if (guard) await guard(tn);
        return await tn
          .snapshot()
          .getRangeAll(r.begin, r.end, { limit: EXTERNAL_SWEEP_BATCH });
      })) as [Buffer, Buffer][];
      observeDue?.(due);
      if (due.length === 0) break;
      for (const [key, value] of due) {
        const parts = this.ks.unpack(key as Buffer);
        const exp = Number(parts[4]);
        const legacy = parts.length === 6;
        const legacyIndex = legacy
          ? decodeJson<{ t: string }>(value as Buffer)
          : null;
        const owner = legacy ? legacyIndex?.t : String(parts[5]);
        const holderId = String(parts[legacy ? 5 : 6]);
        const generation = legacy ? undefined : String(parts[7]);
        if (!owner) {
          await this.db.doTn(async tn => {
            if (guard) await guard(tn);
            tn.clear(key as Buffer);
          });
          continue;
        }
        await this.db.doTn(async tn => {
          if (guard) await guard(tn);
          const current = decodeJson<ExternalSlotRecord>(
            await tn.get(this.key(owner, holderId)),
          );
          // A stale expiry generation must never release a renewed holder.
          if (
            !current ||
            current.e !== exp ||
            current.g !== generation ||
            current.e > now
          ) {
            tn.clear(key as Buffer);
            return;
          }
          await this.releaseInTxn(tn, owner, holderId);
        });
        processed++;
      }
      if (due.length < EXTERNAL_SWEEP_BATCH) break;
    }
    return processed;
  }

  public async sweepExpiredPgBucket(
    now: number,
    bucket: number,
    guard?: ExternalSlotSweepGuard,
    observeDue?: ExternalSlotSweepObserver,
  ): Promise<number> {
    const startedAt = Date.now();
    let processed = 0;
    while (Date.now() - startedAt < EXTERNAL_SWEEP_BUDGET_MS) {
      const range = this.pgExpiryScanRange(bucket, now);
      const due = (await this.db.doTn(async tn => {
        if (guard) await guard(tn);
        return await tn.snapshot().getRangeAll(range.begin, range.end, {
          limit: EXTERNAL_SWEEP_BATCH,
        });
      })) as [Buffer, Buffer][];
      observeDue?.(due);
      if (due.length === 0) break;
      for (const [key] of due) {
        const parts = this.ks.unpack(key);
        const expiresAt = Number(parts[4]);
        const owner = String(parts[5]);
        const holderId = String(parts[6]);
        const generation = String(parts[7]);
        await this.db.doTn(async tn => {
          if (guard) await guard(tn);
          const recordKey = this.pgExpiryRecordKey(owner, holderId);
          const current = decodeJson<PgExternalSlotExpiryRecord>(
            await tn.get(recordKey),
          );
          if (
            !current ||
            current.e !== expiresAt ||
            current.g !== generation ||
            current.t !== owner ||
            current.h !== holderId ||
            current.e > now
          ) {
            tn.clear(key);
            return;
          }
          const objectId = externalSlotMigrationObjectId(owner, holderId);
          const pin = await nuqFdbMigrationStore.inspectPinInTxn(
            tn,
            "external_holder",
            objectId,
          );
          if (!pin) {
            throw new Error(`Missing PG external holder pin ${objectId}`);
          }
          if (pin.teamId !== owner || pin.backend !== "pg") {
            throw new Error(`PG external holder pin mismatch for ${objectId}`);
          }
          if (pin.lifecycle === "active") {
            await nuqFdbMigrationStore.completePinnedObjectInTxn(tn, {
              teamId: owner,
              kind: "external_holder",
              objectId,
              operationId: `nuq-router/v1/external-holder-expiry/${generation}`,
              fromLifecycle: "active",
            });
          } else if (pin.lifecycle !== "terminal") {
            throw new Error(
              `PG external holder expiry found ${pin.lifecycle} pin ${objectId}`,
            );
          }
          tn.clear(recordKey);
          tn.clear(key);
        });
        processed++;
      }
      if (due.length < EXTERNAL_SWEEP_BATCH) break;
    }
    return processed;
  }

  public async sweepExpired(now: number, buckets: number): Promise<void> {
    for (let bucket = 0; bucket < buckets; bucket++) {
      await this.sweepExpiredBucket(now, bucket);
      await this.sweepExpiredPgBucket(now, bucket);
    }
  }
}
