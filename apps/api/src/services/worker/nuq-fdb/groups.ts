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
} from "./ops";

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
};

const DEFAULT_GROUP_TTL_MS = 86400000;

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
    const gMeta = decodeJson<GroupMeta>(await tn.get(this.ks.groupMeta(gid)));
    if (!gMeta || gMeta.s === "completed") {
      tn.clear(this.ks.taskGroupFinish(gid));
      return false;
    }
    const expiresAt = now + gMeta.t;
    const updated: GroupMeta = { ...gMeta, s: "completed", x: expiresAt };
    tn.set(this.ks.groupMeta(gid), encodeJson(updated));
    tn.set(this.ks.groupExpiry(expiresAt, gid), EMPTY);
    tn.clear(this.ks.ongoingGroup(gMeta.o, gid));
    tn.clear(this.ks.taskGroupFinish(gid));

    if (this.finishedKs) {
      const fid = randomUUID();
      const meta: JobMeta = { c: now, p: 0, o: gMeta.o, g: gid, f: 0, dc: 1 };
      tn.set(this.finishedKs.jobMeta(fid), encodeJson(meta));
      tn.set(this.finishedKs.jobData(fid, 0), encodeJson({}));
      const entry: QueueEntry = {
        i: fid,
        o: gMeta.o,
        g: gid,
        p: 0,
        f: 0,
        c: now,
      };
      pushReady(tn, this.finishedKs, entry, txc);
      setStatusQueued(tn, this.finishedKs, fid);
      // pointer for group TTL cleanup to find the finished job's records
      tn.set(this.ks.groupFinishedJob(gid), Buffer.from(fid, "utf8"));
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
      if (existing) return this.toInstance(id, existing);
      const now = Date.now();
      const g: GroupMeta = {
        o: owner,
        c: now,
        t: ttl ?? DEFAULT_GROUP_TTL_MS,
        s: "active",
        m: opts?.maxConcurrency,
        d: opts?.delaySeconds,
      };
      tn.set(this.ks.groupMeta(id), encodeJson(g));
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

  public async getOngoingByOwner(
    ownerId: string,
    logger: Logger = _logger,
  ): Promise<NuQFdbJobGroupInstance[]> {
    const owner = normalizeOwnerId(ownerId);
    if (owner === null) return [];
    return await this.db.doTn(async tn => {
      const r = this.ks.ongoingGroupRange(owner);
      const rows = await tn.snapshot().getRangeAll(r.begin, r.end);
      const out: NuQFdbJobGroupInstance[] = [];
      for (const [key] of rows) {
        const gid = this.ks.unpackId(key as Buffer);
        const g = decodeJson<GroupMeta>(
          await tn.snapshot().get(this.ks.groupMeta(gid)),
        );
        if (g && g.s === "active") out.push(this.toInstance(gid, g));
      }
      return out;
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
      tn.set(
        this.ks.groupMeta(id),
        encodeJson({ ...g, s: "cancelled" } satisfies GroupMeta),
      );
      tn.set(this.ks.taskGroupCancel(id), EMPTY);
      tn.clear(this.ks.ongoingGroup(g.o, id));
      return true;
    });
  }
}
