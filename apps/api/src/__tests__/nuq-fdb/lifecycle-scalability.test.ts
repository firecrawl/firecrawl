import { randomUUID } from "crypto";
import { vi } from "vitest";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import {
  NuQFdbJobGroup,
  NuQFdbQueue,
  NuqFdbExternalSlots,
  NuqFdbSweeper,
} from "../../services/worker/nuq-fdb";
import {
  getFdb,
  getNuqFdbDatabase,
} from "../../services/worker/nuq-fdb/client";
import {
  GroupMeta,
  JobMeta,
  JobStatusRecord,
  TIME_BUCKETS,
  decodeI64,
  decodeJson,
  encodeI64,
  encodeJson,
  timeBucket,
} from "../../services/worker/nuq-fdb/keyspace";
import { EMPTY } from "../../services/worker/nuq-fdb/ops";

const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;
const RUN = randomUUID().slice(0, 8);
const createdQueueNames: string[] = [];

async function makeCtx(name: string) {
  const queueName = `tl-${RUN}-${name}`;
  const finishedName = `${queueName}-fin`;
  createdQueueNames.push(queueName, finishedName);
  const queue = new NuQFdbQueue(queueName, {
    hasGroups: true,
    finishedQueueName: finishedName,
    leaseMs: 500,
  });
  const finishedQueue = new NuQFdbQueue(finishedName, { hasGroups: false });
  const group = new NuQFdbJobGroup(queue.ks, queue.groupOps!);
  const slots = new NuqFdbExternalSlots(queue.ks);
  return {
    queue,
    finishedQueue,
    group,
    slots,
    sweeper: new NuqFdbSweeper([queue, finishedQueue], [slots]),
  };
}

const gate = (teamLimit: number) => ({
  teamLimit,
  queueCap: 1_000_000,
});

function scrapeData() {
  return { mode: "single_urls", url: "https://example.com" };
}

function idInTimeBucket(bucket: number): string {
  for (let i = 0; ; i++) {
    const id = `bucket-${bucket}-${i}`;
    if (timeBucket(id) === bucket) return id;
  }
}

async function rescheduleGroupExpiry(
  queue: NuQFdbQueue,
  gid: string,
  status: GroupMeta["s"],
): Promise<void> {
  const db = getNuqFdbDatabase();
  await db.doTn(async tn => {
    const current = decodeJson<GroupMeta>(
      await tn.get(queue.ks.groupMeta(gid)),
    )!;
    if (current.eg) {
      const oldAt = current.s === "completed" ? current.x : current.a;
      if (oldAt !== undefined) {
        tn.clear(queue.ks.groupExpiry(oldAt, gid, current.eg));
      }
    }
    const expiresAt = Date.now() - 1;
    const generation = randomUUID();
    const next: GroupMeta = {
      ...current,
      s: status,
      eg: generation,
      ...(status === "completed" ? { x: expiresAt } : { a: expiresAt }),
    };
    tn.set(queue.ks.groupMeta(gid), encodeJson(next));
    tn.set(queue.ks.groupExpiry(expiresAt, gid, generation), EMPTY);
  });
}

async function writeInBatches(
  count: number,
  write: (index: number, tn: any) => void,
): Promise<void> {
  const db = getNuqFdbDatabase();
  for (let start = 0; start < count; start += 500) {
    await db.doTn(async tn => {
      for (let i = start; i < Math.min(count, start + 500); i++) write(i, tn);
    });
  }
}

describeIf("NuQ FDB lifecycle scalability", () => {
  afterAll(async () => {
    const fdb = getFdb();
    const db = getNuqFdbDatabase();
    for (const name of createdQueueNames) {
      const range = fdb.tuple.range(["nuq", name]);
      await db.doTn(async tn =>
        tn.clearRange(range.begin as Buffer, range.end as Buffer),
      );
    }
  });

  test("external expiry is tenant-qualified and cannot reap a renewed generation", async () => {
    const { queue, slots, sweeper } = await makeCtx("external-generation");
    const owner = randomUUID();
    const holder = "shared-holder";

    await slots.acquire(owner, holder, -1);
    let stale: [Buffer, Buffer] | undefined;
    for (let bucket = 0; bucket < TIME_BUCKETS && !stale; bucket++) {
      const range = slots.expiryScanRange(bucket, Date.now());
      const rows = await getNuqFdbDatabase().doTn(async tn =>
        tn.snapshot().getRangeAll(range.begin, range.end),
      );
      stale = rows[0] as [Buffer, Buffer] | undefined;
    }
    expect(stale).toBeDefined();

    await slots.acquire(owner, holder, 60_000);
    // Recreate the stale index row to model a sweeper snapshot racing renewal.
    await getNuqFdbDatabase().doTn(async tn => tn.set(stale![0], stale![1]));
    await sweeper.sweepOnce();
    expect(await queue.getTeamActiveCount(owner)).toBe(1);

    const otherOwner = randomUUID();
    await slots.acquire(otherOwner, holder, -1);
    await sweeper.sweepOnce();
    expect(await queue.getTeamActiveCount(owner)).toBe(1);
    expect(await queue.getTeamActiveCount(otherOwner)).toBe(0);
    await slots.release(owner, holder);
  }, 30_000);

  test("malformed external expiry cleanup remains ownership-guarded", async () => {
    const { queue, slots } = await makeCtx("external-malformed");
    const owner = randomUUID();
    await slots.acquire(owner, "live-holder", 60_000);

    const holder = "malformed-holder";
    const bucket = timeBucket(holder);
    const expiresAt = Date.now() - 1_000;
    const malformedKey = queue.ks.pack(["xsexp", bucket, expiresAt, holder]);
    await getNuqFdbDatabase().doTn(async tn =>
      tn.set(malformedKey, encodeJson({})),
    );

    const ownershipLost = new Error("ownership transferred");
    let guardCalls = 0;
    await expect(
      slots.sweepExpiredBucket(Date.now(), bucket, async () => {
        guardCalls++;
        if (guardCalls === 2) throw ownershipLost;
      }),
    ).rejects.toBe(ownershipLost);
    expect(guardCalls).toBe(2);
    await getNuqFdbDatabase().doTn(async tn => {
      expect(await tn.get(malformedKey)).toBeTruthy();
    });
    expect(await queue.getTeamActiveCount(owner)).toBe(1);

    await slots.sweepExpiredBucket(Date.now(), bucket);
    await getNuqFdbDatabase().doTn(async tn => {
      expect(await tn.get(malformedKey)).toBeFalsy();
    });
    expect(await queue.getTeamActiveCount(owner)).toBe(1);
    await slots.release(owner, "live-holder");
  }, 30_000);

  test("renewable pass stays fenced while scanning past more than 25k stale rows", async () => {
    const { queue, finishedQueue, group } = await makeCtx("cancel-25k");
    const sweeper = new NuqFdbSweeper([queue, finishedQueue], [], {
      lockTtlMs: 2_000,
    });
    const owner = randomUUID();
    const gid = randomUUID();
    await group.addGroup(gid, owner);

    const staleCount = 25_100;
    await writeInBatches(staleCount, (i, tn) => {
      tn.set(
        queue.ks.groupJob(gid, `000-stale-${String(i).padStart(6, "0")}`),
        encodeJson({ m: 1, s: "pending" }),
      );
    });

    const pendingId = "zzz-real-pending";
    await queue.addJob(
      pendingId,
      scrapeData(),
      {
        ownerId: owner,
        groupId: gid,
        timesOutAt: new Date(Date.now() + 60_000),
      },
      gate(0),
    );
    expect(await group.cancelGroup(gid)).toBe(true);
    const runningSweep = sweeper.sweepOnce();
    const ownershipKey = queue.ks.sweeperPartition(
      "group-cancel",
      timeBucket(gid),
    );
    const waitDeadline = Date.now() + 15_000;
    let ownershipStart: { w: string; g: string; x: number } | null = null;
    while (!ownershipStart && Date.now() < waitDeadline) {
      ownershipStart = await getNuqFdbDatabase().doTn(async tn =>
        decodeJson<{ w: string; g: string; x: number }>(
          await tn.get(ownershipKey),
        ),
      );
      if (!ownershipStart)
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(ownershipStart).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 2_500));
    const ownershipBefore = await getNuqFdbDatabase().doTn(async tn =>
      decodeJson<{ w: string; g: string; x: number }>(
        await tn.get(ownershipKey),
      ),
    );
    expect(ownershipBefore?.g).toBe(ownershipStart?.g);
    expect(ownershipBefore?.x).toBeGreaterThan(Date.now());

    const contender = new NuqFdbSweeper([queue, finishedQueue], [], {
      lockTtlMs: 2_000,
    });
    const contenderSweep = contender.sweepOnce();
    await Promise.all([runningSweep, contenderSweep]);

    expect(await queue.getJob(pendingId)).toBeNull();
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    await getNuqFdbDatabase().doTn(async tn => {
      expect(await tn.get(queue.ks.taskGroupCancel(gid))).toBeFalsy();
      expect(await tn.get(queue.ks.groupCancelCursor(gid))).toBeFalsy();
    });
  }, 180_000);

  test("group GC deletes every record beyond the former 40k tail", async () => {
    const { queue, group, sweeper } = await makeCtx("gc-40k");
    const owner = randomUUID();
    const gid = randomUUID();
    await group.addGroup(gid, owner);
    await rescheduleGroupExpiry(queue, gid, "completed");

    const memberCount = 40_100;
    await writeInBatches(memberCount, (i, tn) => {
      const id = `member-${String(i).padStart(6, "0")}`;
      const meta: JobMeta = {
        c: Date.now(),
        p: 0,
        o: owner,
        g: gid,
        f: 0,
        dc: 0,
      };
      const status: JobStatusRecord = {
        s: "completed",
        st: 0,
        fa: Date.now(),
      };
      tn.set(queue.ks.groupJob(gid, id), encodeJson({ m: 1, s: "completed" }));
      tn.set(queue.ks.jobMeta(id), encodeJson(meta));
      tn.set(queue.ks.jobStatus(id), encodeJson(status));
    });

    await sweeper.sweepOnce();
    expect(await group.getGroup(gid)).toBeNull();
    expect(await queue.getJob("member-040099")).toBeNull();
  }, 120_000);

  test("abandoned empty groups are cancelled and completed by their deadline", async () => {
    const { queue, group, sweeper } = await makeCtx("abandoned");
    const owner = randomUUID();
    const gid = randomUUID();
    await group.addGroup(gid, owner);
    // Simulate an active group created before abandonment indexes existed.
    await getNuqFdbDatabase().doTn(async tn => {
      const current = decodeJson<GroupMeta>(
        await tn.get(queue.ks.groupMeta(gid)),
      )!;
      tn.clear(queue.ks.groupExpiry(current.a!, gid, current.eg!));
      const { a: _a, eg: _eg, ...legacy } = current;
      tn.set(queue.ks.groupMeta(gid), encodeJson(legacy));
    });
    await sweeper.sweepOnce();
    const backfilled = await getNuqFdbDatabase().doTn(async tn =>
      decodeJson<GroupMeta>(await tn.get(queue.ks.groupMeta(gid))),
    );
    expect(backfilled?.a).toBeDefined();
    expect(backfilled?.eg).toBeDefined();
    await rescheduleGroupExpiry(queue, gid, "active");

    for (let i = 0; i < 3; i++) await sweeper.sweepOnce();
    expect((await group.getGroup(gid))?.status).toBe("completed");
  }, 30_000);

  test("group TTL never deletes queued or active crawl-finished control work", async () => {
    const { queue, finishedQueue, group, sweeper } =
      await makeCtx("finish-control");
    const owner = randomUUID();
    const gid = randomUUID();
    await group.addGroup(gid, owner, 10);
    const id = randomUUID();
    await queue.addJob(
      id,
      scrapeData(),
      { ownerId: owner, groupId: gid },
      gate(10),
    );
    const member = await queue.getJobToProcess();
    await queue.jobFinish(member!.id, member!.lock!, null);
    const fid = await getNuqFdbDatabase().doTn(async tn =>
      (await tn.get(queue.ks.groupFinishedJob(gid)))!.toString("utf8"),
    );

    await rescheduleGroupExpiry(queue, gid, "completed");
    await sweeper.sweepOnce();
    expect((await group.getGroup(gid))?.status).toBe("completed");
    expect((await finishedQueue.getJob(fid))?.status).toBe("queued");

    const control = await finishedQueue.getJobToProcess();
    expect(control?.id).toBe(fid);
    await rescheduleGroupExpiry(queue, gid, "completed");
    await sweeper.sweepOnce();
    expect(await group.getGroup(gid)).not.toBeNull();
    expect((await finishedQueue.getJob(fid))?.status).toBe("active");

    await finishedQueue.jobFinish(fid, control!.lock!, null);
    await rescheduleGroupExpiry(queue, gid, "completed");
    await sweeper.sweepOnce();
    expect(await group.getGroup(gid)).toBeNull();
  }, 30_000);

  test("a concurrent team-limit generation cannot be cleared by an older raise", async () => {
    const { queue, sweeper } = await makeCtx("raise-generation");
    const owner = randomUUID();
    await queue.addJobs(
      Array.from({ length: 4 }, () => ({
        id: randomUUID(),
        data: scrapeData(),
        options: {
          ownerId: owner,
          timesOutAt: new Date(Date.now() + 60_000),
        },
      })),
      gate(1),
    );
    await getNuqFdbDatabase().doTn(async tn => {
      tn.set(queue.ks.teamLimit(owner), encodeI64(2));
      tn.set(queue.ks.taskTeamRaise(owner), encodeJson({ g: randomUUID() }));
    });

    await Promise.all([
      sweeper.sweepOnce(),
      queue.addJob(
        randomUUID(),
        scrapeData(),
        { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
        gate(3),
      ),
    ]);
    await sweeper.sweepOnce();
    expect(await queue.getTeamActiveCount(owner)).toBe(3);
    expect(await queue.getTeamPendingCount(owner)).toBe(2);
  }, 30_000);

  test("historical zero team and key ledgers are indexed and collected", async () => {
    const { queue, sweeper } = await makeCtx("ledger-gc");
    const teamId = randomUUID();
    const keyId = randomUUID();
    await getNuqFdbDatabase().doTn(async tn => {
      tn.set(queue.ks.teamLimit(teamId), encodeI64(10));
      tn.set(queue.ks.teamActive(teamId), encodeI64(0));
      tn.set(queue.ks.keyLimit(keyId), encodeI64(10));
      tn.set(queue.ks.keyActive(keyId), encodeI64(0));
    });

    for (let i = 0; i < 3; i++) await sweeper.sweepOnce();
    await getNuqFdbDatabase().doTn(async tn => {
      // Cold limits remain to protect latent delayed/crawl-pending work;
      // mutable zero counters and historical discovery tails are collected.
      expect(await tn.get(queue.ks.teamLimit(teamId))).toBeTruthy();
      expect(await tn.get(queue.ks.keyLimit(keyId))).toBeTruthy();
      expect(await tn.get(queue.ks.teamActive(teamId))).toBeFalsy();
      expect(await tn.get(queue.ks.keyActive(keyId))).toBeFalsy();
      expect(await tn.get(queue.ks.teamActiveIndex(teamId))).toBeFalsy();
      expect(await tn.get(queue.ks.keyLedgerIndex(keyId))).toBeFalsy();
    });
  }, 30_000);

  test("a staged ingest reservation keeps the team ledger live until release", async () => {
    const { queue, sweeper } = await makeCtx("ledger-reservation");
    const owner = randomUUID();
    const id = randomUUID();
    let publishStarted!: () => void;
    let releasePublish!: () => void;
    const started = new Promise<void>(resolve => {
      publishStarted = resolve;
    });
    const blocked = new Promise<void>(resolve => {
      releasePublish = resolve;
    });
    const originalPublish = (queue as any).publishIngestBatch.bind(queue);
    const publish = vi
      .spyOn(queue as any, "publishIngestBatch")
      .mockImplementation(async (...args: unknown[]) => {
        publishStarted();
        await blocked;
        return await originalPublish(...args);
      });
    const adding = queue.addJobs(
      [
        {
          id,
          data: scrapeData(),
          options: { ownerId: owner },
        },
      ],
      gate(10),
    );

    await started;
    try {
      await sweeper.sweepOnce();
      await getNuqFdbDatabase().doTn(async tn => {
        expect(
          decodeI64(await tn.get(queue.ks.teamIngestReserved(owner))),
        ).toBe(1);
        expect(await tn.get(queue.ks.teamLedgerGcIndex(owner))).toBeTruthy();
      });
    } finally {
      releasePublish();
      await adding;
      publish.mockRestore();
    }

    const job = await queue.getJobToProcess();
    expect(job?.id).toBe(id);
    await queue.jobFinish(job!.id, job!.lock!, null);
    await sweeper.sweepOnce();
    await getNuqFdbDatabase().doTn(async tn => {
      expect(await tn.get(queue.ks.teamLimit(owner))).toBeTruthy();
      expect(await tn.get(queue.ks.teamIngestReserved(owner))).toBeFalsy();
      expect(await tn.get(queue.ks.teamLedgerGcIndex(owner))).toBeFalsy();
    });
  }, 30_000);

  test("group lifecycle buckets progress independently across replicas", async () => {
    const { queue, group, sweeper } = await makeCtx("group-partitions");
    const owner = randomUUID();
    const firstGroup = randomUUID();
    let secondGroup = randomUUID();
    while (timeBucket(secondGroup) === timeBucket(firstGroup)) {
      secondGroup = randomUUID();
    }
    const firstJob = randomUUID();
    const secondJob = randomUUID();
    for (const [gid, id] of [
      [firstGroup, firstJob],
      [secondGroup, secondJob],
    ]) {
      await group.addGroup(gid, owner);
      await queue.addJob(
        id,
        scrapeData(),
        {
          ownerId: owner,
          groupId: gid,
          timesOutAt: new Date(Date.now() + 60_000),
        },
        gate(0),
      );
      await group.cancelGroup(gid);
    }
    await getNuqFdbDatabase().doTn(async tn => {
      tn.set(
        queue.ks.sweeperPartition("group-cancel", timeBucket(firstGroup)),
        encodeJson({ w: "other", g: randomUUID(), x: Date.now() + 60_000 }),
      );
    });

    await sweeper.sweepOnce();
    expect(await queue.getJob(firstJob)).not.toBeNull();
    expect(await queue.getJob(secondJob)).toBeNull();
  }, 30_000);

  test("partition protocol fences old singleton sweepers during rollout", async () => {
    const { queue, finishedQueue } = await makeCtx("legacy-fence");
    const sweeper = new NuqFdbSweeper([queue, finishedQueue]);
    const id = randomUUID();
    await getNuqFdbDatabase().doTn(async tn => {
      tn.set(
        queue.ks.jobMeta(id),
        encodeJson({ c: 0, p: 0, o: "", f: 0, dc: 0 } satisfies JobMeta),
      );
      tn.set(
        queue.ks.jobStatus(id),
        encodeJson({ s: "cancelled", st: 0 } satisfies JobStatusRecord),
      );
      tn.set(queue.ks.jobExpiry(timeBucket(id), Date.now() - 1, id), EMPTY);
      tn.set(
        queue.ks.legacySweeperLock(),
        encodeJson({ w: "old-owner", x: Date.now() + 60_000 }),
      );
    });

    await sweeper.sweepOnce();
    expect(await queue.hasJob(id)).toBe(true);
    await getNuqFdbDatabase().doTn(async tn => {
      tn.set(
        queue.ks.legacySweeperLock(),
        encodeJson({ w: "old-owner", x: Date.now() - 1 }),
      );
    });
    await sweeper.sweepOnce();
    expect(await queue.hasJob(id)).toBe(false);

    const oldCouldAcquire = await getNuqFdbDatabase().doTn(async tn => {
      const current = decodeJson<{ w: string; x: number }>(
        await tn.get(queue.ks.legacySweeperLock()),
      );
      if (current && current.x > Date.now() && current.w !== "old-candidate") {
        return false;
      }
      tn.set(
        queue.ks.legacySweeperLock(),
        encodeJson({ w: "old-candidate", x: Date.now() + 15_000 }),
      );
      return true;
    });
    expect(oldCouldAcquire).toBe(false);
  }, 30_000);

  test("overdue metrics use observed scans and reset after the partition drains", async () => {
    const { queue } = await makeCtx("overdue-metric");
    const sweeper = new NuqFdbSweeper([queue]);
    const dueAt = Date.now() - 5_000;
    const id = idInTimeBucket(0);
    await getNuqFdbDatabase().doTn(async tn => {
      tn.set(
        queue.ks.delayed(0, dueAt, id),
        encodeJson({ i: id, o: "", p: 0, f: 0, c: dueAt }),
      );
    });

    await sweeper.sweepOnce();
    const line = sweeper
      .getMetrics()
      .split("\n")
      .find(value =>
        value.includes(
          `queue="${queue.queueName}",index="delay",partition="0"`,
        ),
      );
    expect(line).toBeDefined();
    expect(Number(line!.split(" ")[1])).toBeGreaterThanOrEqual(5);

    const db = getNuqFdbDatabase();
    const doTn = vi.spyOn(db, "doTn");
    const readsBeforeCollection = doTn.mock.calls.length;
    sweeper.getMetrics();
    expect(doTn.mock.calls).toHaveLength(readsBeforeCollection);
    doTn.mockRestore();

    await sweeper.sweepOnce();
    expect(sweeper.getMetrics()).not.toContain(
      `queue="${queue.queueName}",index="delay",partition="0"`,
    );
  }, 30_000);

  test("claim and ingest expiry metrics use bounded ownership labels", async () => {
    const { queue } = await makeCtx("overdue-ingest");
    const sweeper = new NuqFdbSweeper([queue]);
    const dueAt = Date.now() - 5_000;
    await getNuqFdbDatabase().doTn(async tn => {
      for (let i = 0; i < 3; i++) {
        const claimOp = `claim-${i}`;
        tn.set(queue.ks.claim(claimOp), encodeJson({ e: dueAt + i }));
        tn.set(queue.ks.claimExpiry(dueAt + i, claimOp), EMPTY);
        tn.set(queue.ks.ingestExpiry(dueAt + i, `ingest-${i}`), EMPTY);
      }
    });

    await sweeper.sweepOnce();
    const metricLines = sweeper
      .getMetrics()
      .split("\n")
      .filter(line => line.startsWith("firecrawl_nuq_fdb_sweeper_"));
    expect(
      metricLines.filter(line =>
        line.includes(
          `queue="${queue.queueName}",index="claim_expiry",partition="0"`,
        ),
      ),
    ).toHaveLength(1);
    expect(
      metricLines.filter(line =>
        line.includes(
          `queue="${queue.queueName}",index="ingest_expiry",partition="0"`,
        ),
      ),
    ).toHaveLength(1);
    expect(metricLines.join("\n")).not.toContain("claim-0");
    expect(metricLines.join("\n")).not.toContain("ingest-0");

    await sweeper.sweepOnce();
    expect(sweeper.getMetrics()).not.toContain('index="claim_expiry"');
    expect(sweeper.getMetrics()).not.toContain('index="ingest_expiry"');
  }, 30_000);

  test("an ownership transfer removes the previous sweeper's stale label", async () => {
    const { queue } = await makeCtx("overdue-transfer");
    const dueAt = Date.now() - 5_000;
    const id = idInTimeBucket(0);
    await getNuqFdbDatabase().doTn(async tn => {
      tn.set(
        queue.ks.delayed(0, dueAt, id),
        encodeJson({ i: id, o: "", p: 0, f: 0, c: dueAt }),
      );
    });

    const previous = new NuqFdbSweeper([queue], [], { lockTtlMs: 2_000 });
    await previous.sweepOnce(logger, 3);
    expect(previous.getMetrics()).toContain(
      `queue="${queue.queueName}",index="delay",partition="0"`,
    );
    const ownershipKey = queue.ks.sweeperPartition("delay", 0);
    const firstGeneration = await getNuqFdbDatabase().doTn(async tn =>
      decodeJson<{ g: string; x: number }>(await tn.get(ownershipKey)),
    );

    while (Date.now() <= firstGeneration!.x) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await getNuqFdbDatabase().doTn(async tn => {
      // New overdue work arriving at transfer time must be exported only by
      // the next owner; the expired owner's earlier sample must disappear.
      tn.set(
        queue.ks.delayed(0, dueAt, id),
        encodeJson({ i: id, o: "", p: 0, f: 0, c: dueAt }),
      );
    });
    const next = new NuqFdbSweeper([queue], [], { lockTtlMs: 2_000 });
    await next.sweepOnce(logger, 3);
    const nextGeneration = await getNuqFdbDatabase().doTn(async tn =>
      decodeJson<{ g: string }>(await tn.get(ownershipKey)),
    );
    expect(nextGeneration?.g).not.toBe(firstGeneration?.g);
    expect(previous.getMetrics()).not.toContain(
      `queue="${queue.queueName}",index="delay",partition="0"`,
    );
    expect(next.getMetrics()).toContain(
      `queue="${queue.queueName}",index="delay",partition="0"`,
    );
  }, 30_000);

  test("partition leases fail over and multiple sweepers drain disjoint buckets", async () => {
    const { queue, finishedQueue } = await makeCtx("partitions");
    const db = getNuqFdbDatabase();
    const count = 1_000;
    await writeInBatches(count, (i, tn) => {
      const id = `expired-${String(i).padStart(5, "0")}`;
      tn.set(
        queue.ks.jobMeta(id),
        encodeJson({ c: 0, p: 0, o: "", f: 0, dc: 0 } satisfies JobMeta),
      );
      tn.set(
        queue.ks.jobStatus(id),
        encodeJson({ s: "cancelled", st: 0 } satisfies JobStatusRecord),
      );
      tn.set(queue.ks.jobExpiry(timeBucket(id), Date.now() - 1, id), EMPTY);
    });

    // Hold one known partition on behalf of a dead replica.
    const blockedBucket = timeBucket("expired-00000");
    await db.doTn(async tn => {
      tn.set(
        queue.ks.sweeperPartition("job-expiry", blockedBucket),
        encodeJson({ w: "dead", g: randomUUID(), x: Date.now() + 60_000 }),
      );
    });

    const a = new NuqFdbSweeper([queue, finishedQueue], [], {
      lockTtlMs: 100,
      maxPartitionsPerTick: 12,
    });
    const b = new NuqFdbSweeper([queue, finishedQueue], [], {
      lockTtlMs: 100,
      maxPartitionsPerTick: 12,
    });
    await Promise.all([a.sweepOnce(logger, 12), b.sweepOnce(logger, 12)]);
    expect(await queue.hasJob("expired-00000")).toBe(true);

    await db.doTn(async tn => {
      tn.set(
        queue.ks.sweeperPartition("job-expiry", blockedBucket),
        encodeJson({ w: "dead", g: randomUUID(), x: Date.now() - 1 }),
      );
    });
    for (let i = 0; i < 12; i++) {
      await Promise.all([a.sweepOnce(logger, 12), b.sweepOnce(logger, 12)]);
    }
    for (const id of ["expired-00000", "expired-00500", "expired-00999"]) {
      expect(await queue.hasJob(id)).toBe(false);
    }
  }, 60_000);
});
