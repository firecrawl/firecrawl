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
};

export class NuqFdbExternalSlots {
  constructor(public readonly ks: NuqFdbKeyspace) {}

  private get db() {
    return getNuqFdbDatabase();
  }

  private key(teamId: string, holderId: string): Buffer {
    return this.ks.pack(["xs", teamId, holderId]);
  }

  private expiryKey(bucket: number, expMs: number, holderId: string): Buffer {
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
    await this.db.doTn(async tn => {
      const existing = decodeJson<ExternalSlotRecord>(
        await tn.get(this.key(owner, holderId)),
      );
      if (existing) {
        tn.clear(this.expiryKey(timeBucket(holderId), existing.e, holderId));
      } else {
        bumpTeamActive(tn, this.ks, owner, 1);
      }
      tn.set(
        this.key(owner, holderId),
        encodeJson({ e: exp } satisfies ExternalSlotRecord),
      );
      tn.set(
        this.expiryKey(timeBucket(holderId), exp, holderId),
        encodeJson({ t: owner }),
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
    tn.clear(this.expiryKey(timeBucket(holderId), existing.e, holderId));
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
      { team: true, crawl: false },
      Date.now(),
      newTxContext(),
    );
    return true;
  }

  // Sweeper hook: releases slots whose holders stopped renewing.
  public async sweepExpired(now: number, buckets: number): Promise<void> {
    for (let b = 0; b < buckets; b++) {
      const r = this.expiryScanRange(b, now);
      const due = await this.db.doTn(async tn =>
        tn.snapshot().getRangeAll(r.begin, r.end, { limit: 50 }),
      );
      for (const [key, value] of due) {
        const holderId = this.ks.unpackId(key as Buffer);
        const rec = decodeJson<{ t: string }>(value as Buffer);
        if (!rec) continue;
        await this.db.doTn(async tn => {
          // releaseInTxn validates the record still exists (and clears this
          // index entry); if the holder renewed, just drop the stale entry
          const released = await this.releaseInTxn(tn, rec.t, holderId);
          if (!released) tn.clear(key as Buffer);
        });
      }
    }
  }
}
