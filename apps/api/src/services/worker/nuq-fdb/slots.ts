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
import { bumpTeamActive, newTxContext, releaseSlotsAndPromote } from "./ops";

// External slots: capacity consumed by things that are not queue jobs (sync
// scrapes via the team semaphore, browser sessions). They unconditionally bump
// the team active counter -- possibly past the limit, matching the old Redis
// behavior where sync holders were mirrored into the same ZSET -- and hand
// their slot through the normal promotion chain on release.

type ExternalSlotRecord = {
  e: number; // expiry ms
  g?: string; // renewal generation (absent on pre-generation records)
};

export type ExternalSlotSweepGuard = (tn: Transaction) => Promise<void>;
export type ExternalSlotSweepObserver = (
  due: readonly [Buffer, Buffer][],
) => void;

const EXTERNAL_SWEEP_BATCH = 100;
const EXTERNAL_SWEEP_BUDGET_MS = 5_000;

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

  public expiryScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.ks.pack(["xsexp", bucket]),
      end: this.ks.pack(["xsexp", bucket, untilMs]),
    };
  }

  // Acquires (or renews) an external slot. Unconditional: never blocks on the
  // team limit; the caller's own gate (Lua semaphore, session limits) decides
  // admission. Re-acquiring an existing holder just extends its expiry.
  public async acquire(
    teamId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<void> {
    const owner = normalizeOwnerId(teamId);
    if (owner === null) return;
    const now = Date.now();
    const exp = now + ttlMs;
    const generation = randomUUID();
    await this.db.doTn(async tn => {
      const existing = decodeJson<ExternalSlotRecord>(
        await tn.get(this.key(owner, holderId)),
      );
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
      tn.set(
        this.key(owner, holderId),
        encodeJson({ e: exp, g: generation } satisfies ExternalSlotRecord),
      );
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
    });
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

  public async sweepExpired(now: number, buckets: number): Promise<void> {
    for (let bucket = 0; bucket < buckets; bucket++) {
      await this.sweepExpiredBucket(now, bucket);
    }
  }
}
