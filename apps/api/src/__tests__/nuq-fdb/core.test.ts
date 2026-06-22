import { randomUUID } from "crypto";
import { config } from "../../config";
import {
  NuQFdbQueue,
  NuQFdbJobGroup,
  NuqFdbSweeper,
} from "../../services/worker/nuq-fdb";
import {
  getNuqFdbDatabase,
  getFdb,
} from "../../services/worker/nuq-fdb/client";
import { encodeI64, encodeJson } from "../../services/worker/nuq-fdb/keyspace";

// These tests exercise the FDB queue core directly against a real FoundationDB
// cluster (no API server needed). They are skipped when FDB is not configured.
const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;

// inline returnvalues only exist on the self-host path; cloud stores to GCS
const expectInlineReturnvalue = !config.GCS_BUCKET_NAME;

const RUN = randomUUID().slice(0, 8);
const TEST_LEASE_MS = 1500;

const createdQueueNames: string[] = [];

type Ctx = {
  queue: NuQFdbQueue;
  finishedQueue: NuQFdbQueue;
  group: NuQFdbJobGroup;
  sweeper: NuqFdbSweeper;
};

// Each test gets its own queue keyspace so leaked jobs (some tests leave them
// behind on purpose) can never bleed into other tests' takes.
async function makeCtx(name: string): Promise<Ctx> {
  const scrapeName = `t-${RUN}-${name}`;
  const finishedName = `t-${RUN}-${name}-fin`;
  createdQueueNames.push(scrapeName, finishedName);
  const queue = new NuQFdbQueue(scrapeName, {
    hasGroups: true,
    finishedQueueName: finishedName,
    leaseMs: TEST_LEASE_MS,
  });
  const finishedQueue = new NuQFdbQueue(finishedName, { hasGroups: false });
  const group = new NuQFdbJobGroup(queue.ks, queue.groupOps!);
  const sweeper = new NuqFdbSweeper([queue, finishedQueue]);
  return { queue, finishedQueue, group, sweeper };
}

async function takeAll(
  queue: NuQFdbQueue,
  maxJobs: number = 50,
): Promise<any[]> {
  const out: any[] = [];
  while (out.length < maxJobs) {
    const job = await queue.getJobToProcess();
    if (job === null) break;
    out.push(job);
  }
  return out;
}

function freshOwner(): string {
  return randomUUID();
}

function scrapeData(extra: Record<string, any> = {}): any {
  return { mode: "single_urls", url: "https://example.com", ...extra };
}

const UNLIMITED = { teamLimit: null, queueCap: 1_000_000 };
const gate = (limit: number, cap: number = 1_000_000) => ({
  teamLimit: limit,
  queueCap: cap,
});

describeIf("NuQ FDB core", () => {
  afterAll(async () => {
    const fdb = getFdb();
    const db = getNuqFdbDatabase();
    for (const name of createdQueueNames) {
      const r = fdb.tuple.range(["nuq", name]);
      await db.doTn(async tn =>
        tn.clearRange(r.begin as Buffer, r.end as Buffer),
      );
    }
  });

  test("enqueue -> take -> finish roundtrip (ungated)", async () => {
    const { queue } = await makeCtx("roundtrip");
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: freshOwner() }, UNLIMITED);

    const taken = await takeAll(queue, 1);
    expect(taken.length).toBe(1);
    expect(taken[0].id).toBe(id);
    expect(taken[0].lock).toBeDefined();
    expect(taken[0].data.url).toBe("https://example.com");

    const ok = await queue.jobFinish(id, taken[0].lock!, { result: "yay" });
    expect(ok).toBe(true);

    const job = await queue.getJob(id);
    expect(job?.status).toBe("completed");
    if (expectInlineReturnvalue) {
      expect(job?.returnvalue).toEqual({ result: "yay" });
    } else {
      expect(job?.returnvalue).toBeNull();
    }
  });

  test("finish with wrong lock is rejected; double finish is idempotent", async () => {
    const { queue } = await makeCtx("locks");
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: freshOwner() }, UNLIMITED);
    const [job] = await takeAll(queue, 1);
    expect(job.id).toBe(id);

    expect(await queue.jobFinish(id, randomUUID(), null)).toBe(false);
    expect(await queue.jobFinish(id, job.lock!, { ok: 1 })).toBe(true);
    expect(await queue.jobFinish(id, job.lock!, { ok: 1 })).toBe(true);
    expect(await queue.jobFail(id, job.lock!, "nope")).toBe(false);
  });

  test("team concurrency gate: limit 2 admits 2, backlogs the rest, promotes on finish", async () => {
    const { queue } = await makeCtx("teamgate");
    const owner = freshOwner();
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const jobs = await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      })),
      gate(2),
    );

    expect(jobs.filter(j => j.status === "queued").length).toBe(2);
    expect(jobs.filter(j => j.status === "backlog").length).toBe(3);
    expect(await queue.getTeamActiveCount(owner)).toBe(2);
    expect(await queue.getTeamPendingCount(owner)).toBe(3);
    expect(await queue.getWorkerLoadCount()).toBe(2);

    const queuedMetrics = await queue.getMetrics();
    expect(queuedMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="queued"} 2`,
    );
    expect(queuedMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="active"} 0`,
    );
    expect(queuedMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="backlog"} 3`,
    );

    const taken = await takeAll(queue, 5);
    expect(taken.length).toBe(2);
    expect(await queue.getWorkerLoadCount()).toBe(2);

    const activeMetrics = await queue.getMetrics();
    expect(activeMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="queued"} 0`,
    );
    expect(activeMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="active"} 2`,
    );
    expect(activeMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="backlog"} 3`,
    );

    // finishing one job promotes exactly one backlogged job
    await queue.jobFinish(taken[0].id, taken[0].lock!, null);
    expect(await queue.getTeamActiveCount(owner)).toBe(2);
    expect(await queue.getTeamPendingCount(owner)).toBe(2);

    const next = await takeAll(queue, 5);
    expect(next.length).toBe(1);

    await queue.jobFinish(taken[1].id, taken[1].lock!, null);
    await queue.jobFinish(next[0].id, next[0].lock!, null);
    const rest = await takeAll(queue, 5);
    expect(rest.length).toBe(2);
    for (const j of rest) await queue.jobFinish(j.id, j.lock!, null);
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
  });

  test("metrics count pending teams even without active index entries", async () => {
    const { queue } = await makeCtx("pending-metrics");
    const owner = freshOwner();

    await getNuqFdbDatabase().doTn(async tn => {
      tn.set(queue.ks.teamPendingCount(owner), encodeI64(4));
    });

    const metrics = await queue.getMetrics();
    expect(metrics).toContain(
      `nuq_fdb_queue_t_${RUN}_pending_metrics_job_count{status="backlog"} 4`,
    );
  });

  test("promotion respects priority order", async () => {
    const { queue } = await makeCtx("priority");
    const owner = freshOwner();
    const blocker = randomUUID();
    await queue.addJob(
      blocker,
      scrapeData(),
      { ownerId: owner, priority: 0 },
      gate(1),
    );
    const lowPrio = randomUUID();
    const highPrio = randomUUID();
    await queue.addJob(
      lowPrio,
      scrapeData(),
      {
        ownerId: owner,
        priority: 50,
        timesOutAt: new Date(Date.now() + 60_000),
      },
      gate(1),
    );
    await queue.addJob(
      highPrio,
      scrapeData(),
      {
        ownerId: owner,
        priority: 1,
        timesOutAt: new Date(Date.now() + 60_000),
      },
      gate(1),
    );

    const [b] = await takeAll(queue, 1);
    expect(b.id).toBe(blocker);
    await queue.jobFinish(b.id, b.lock!, null);

    const [promoted] = await takeAll(queue, 1);
    expect(promoted.id).toBe(highPrio);
  });

  test("kickoff jobs bypass the gate and hold no slot", async () => {
    const { queue } = await makeCtx("kickoff");
    const owner = freshOwner();
    const kickoff = randomUUID();
    await queue.addJob(
      kickoff,
      { mode: "kickoff", crawl_id: randomUUID() },
      { ownerId: owner, bypassGate: true },
      gate(1),
    );
    expect(await queue.getTeamActiveCount(owner)).toBe(0);

    const [k] = await takeAll(queue, 1);
    expect(k.id).toBe(kickoff);
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
    await queue.jobFinish(k.id, k.lock!, null);
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
  });

  test("QueueFullError when the backlog cap is exceeded", async () => {
    const { queue } = await makeCtx("qfull");
    const owner = freshOwner();
    const blocker = randomUUID();
    await queue.addJob(blocker, scrapeData(), { ownerId: owner }, gate(1, 2));
    // 1 active, cap 2: two backlogged jobs fit, the third addJobs blows up
    await queue.addJobs(
      [randomUUID(), randomUUID()].map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      })),
      gate(1, 2),
    );
    await expect(
      queue.addJob(
        randomUUID(),
        scrapeData(),
        { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
        gate(1, 2),
      ),
    ).rejects.toThrow(/queue limit reached/i);
  });

  test("group lifecycle: numeric stats, finish detection, crawl_finished emission", async () => {
    const { queue, finishedQueue, group } = await makeCtx("glife");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);

    const ids = Array.from({ length: 3 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, groupId: gid },
      })),
      gate(10),
    );

    let stats = await queue.getGroupNumericStats(gid);
    expect(stats.queued).toBe(3);

    const taken = await takeAll(queue, 3);
    expect(taken.length).toBe(3);
    stats = await queue.getGroupNumericStats(gid);
    expect(stats.active).toBe(3);

    for (const j of taken.slice(0, 2))
      await queue.jobFinish(j.id, j.lock!, null);
    await queue.jobFail(taken[2].id, taken[2].lock!, "boom");

    stats = await queue.getGroupNumericStats(gid);
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.active).toBe(0);

    // the last terminal transition completes the group inline
    const g = await group.getGroup(gid);
    expect(g?.status).toBe("completed");
    expect(g?.expiresAt).toBeDefined();

    // and emits exactly one crawl_finished job
    const finishedJob = await finishedQueue.getJobToProcess();
    expect(finishedJob).not.toBeNull();
    expect(finishedJob!.groupId).toBe(gid);
    expect(await finishedQueue.getJobToProcess()).toBeNull();
    await finishedQueue.jobFinish(finishedJob!.id, finishedJob!.lock!, null);

    const ongoing = await group.getOngoingByOwner(owner);
    expect(ongoing.find(o => o.id === gid)).toBeUndefined();
  });

  test("crawl maxConcurrency gates within the team limit", async () => {
    const { queue, group } = await makeCtx("crawlmax");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner, undefined, { maxConcurrency: 1 });

    const ids = Array.from({ length: 3 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: {
          ownerId: owner,
          groupId: gid,
          timesOutAt: new Date(Date.now() + 60_000),
        },
      })),
      gate(10),
    );

    // only 1 crawl slot: one job ready, two crawl-pending
    expect(await queue.getTeamActiveCount(owner)).toBe(1);
    const taken1 = await takeAll(queue, 3);
    expect(taken1.length).toBe(1);

    await queue.jobFinish(taken1[0].id, taken1[0].lock!, null);
    const taken2 = await takeAll(queue, 3);
    expect(taken2.length).toBe(1);

    await queue.jobFinish(taken2[0].id, taken2[0].lock!, null);
    const taken3 = await takeAll(queue, 3);
    expect(taken3.length).toBe(1);
    await queue.jobFinish(taken3[0].id, taken3[0].lock!, null);

    const g = await group.getGroup(gid);
    expect(g?.status).toBe("completed");
  });

  test("crawl delay: next job is parked until the not-before time", async () => {
    const { queue, group, sweeper } = await makeCtx("delay");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner, undefined, { delaySeconds: 1 });

    const ids = [randomUUID(), randomUUID()];
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: {
          ownerId: owner,
          groupId: gid,
          timesOutAt: new Date(Date.now() + 60_000),
        },
      })),
      gate(10),
    );

    const [first] = await takeAll(queue, 2);
    expect(first).toBeDefined();
    await queue.jobFinish(first.id, first.lock!, null);

    // second job is in the delay index, not takeable yet
    await sweeper.sweepOnce();
    expect(await queue.getJobToProcess()).toBeNull();

    await new Promise(resolve => setTimeout(resolve, 1200));
    await sweeper.sweepOnce();
    const [second] = await takeAll(queue, 1);
    expect(second).toBeDefined();
    expect(second.id).toBe(ids.find(i => i !== first.id));
    await queue.jobFinish(second.id, second.lock!, null);
  });

  test("lease expiry: sweeper requeues a stalled job, then fails it after MAX_STALLS", async () => {
    const { queue, sweeper } = await makeCtx("stalls");
    const owner = freshOwner();
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: owner }, gate(5));

    const [job] = await takeAll(queue, 1);
    expect(job.id).toBe(id);

    // let the lease expire without renewal
    await new Promise(resolve => setTimeout(resolve, TEST_LEASE_MS + 200));
    await sweeper.sweepOnce();

    let j = await queue.getJob(id);
    expect(j?.status).toBe("queued");

    // worker that lost its lease can no longer finish
    expect(await queue.jobFinish(id, job.lock!, null)).toBe(false);

    // stall it to death
    for (let i = 0; i < 9; i++) {
      const [again] = await takeAll(queue, 1);
      expect(again.id).toBe(id);
      await new Promise(resolve => setTimeout(resolve, TEST_LEASE_MS + 200));
      await sweeper.sweepOnce();
    }
    j = await queue.getJob(id);
    expect(j?.status).toBe("failed");
    expect(j?.failedReason).toMatch(/stalled/i);
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
  }, 60_000);

  test("renewLock keeps the lease alive", async () => {
    const { queue, sweeper } = await makeCtx("renew");
    const owner = freshOwner();
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: owner }, gate(5));
    const [job] = await takeAll(queue, 1);

    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, TEST_LEASE_MS / 2));
      expect(await queue.renewLock(id, job.lock!)).toBe(true);
    }
    await sweeper.sweepOnce();
    const j = await queue.getJob(id);
    expect(j?.status).toBe("active");
    expect(await queue.jobFinish(id, job.lock!, null)).toBe(true);
  }, 30_000);

  test("backlog timeout: pending jobs are silently dropped at their deadline", async () => {
    const { queue, sweeper } = await makeCtx("bto");
    const owner = freshOwner();
    const blocker = randomUUID();
    await queue.addJob(blocker, scrapeData(), { ownerId: owner }, gate(1));
    const doomed = randomUUID();
    await queue.addJob(
      doomed,
      scrapeData(),
      { ownerId: owner, timesOutAt: new Date(Date.now() - 1000) },
      gate(1),
    );

    expect(await queue.getTeamPendingCount(owner)).toBe(1);
    await sweeper.sweepOnce();
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    expect(await queue.getJob(doomed)).toBeNull();

    const [b] = await takeAll(queue, 1);
    await queue.jobFinish(b.id, b.lock!, null);
  });

  test("group cancellation: pending dropped, ready diverted, group still completes", async () => {
    const { queue, finishedQueue, group, sweeper } = await makeCtx("cancel");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);

    const ids = Array.from({ length: 4 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: {
          ownerId: owner,
          groupId: gid,
          timesOutAt: new Date(Date.now() + 60_000),
        },
      })),
      gate(2),
    );
    // 2 ready, 2 team-pending
    const [active] = await takeAll(queue, 1);

    expect(await group.cancelGroup(gid)).toBe(true);
    await sweeper.sweepOnce(); // cleans pending members

    // the remaining ready job is diverted at take time
    const after = await takeAll(queue, 4);
    expect(after.length).toBe(0);

    // active job finishes normally; that drains the group
    await queue.jobFinish(active.id, active.lock!, null);
    await sweeper.sweepOnce();

    const g = await group.getGroup(gid);
    expect(g?.status).toBe("completed");
    expect(await queue.getTeamActiveCount(owner)).toBe(0);

    // cancelled crawls still emit their crawl_finished job
    const fin = await finishedQueue.getJobToProcess();
    expect(fin).not.toBeNull();
    expect(fin!.groupId).toBe(gid);
    await finishedQueue.jobFinish(fin!.id, fin!.lock!, null);
  });

  test("group cancellation scans past stale group-index rows before clearing task", async () => {
    const { queue, group, sweeper } = await makeCtx("cancel-stale-index");
    const db = getNuqFdbDatabase();
    const owner = freshOwner();
    const gid = randomUUID();
    const pendingId = "zzzz-real-pending";
    await group.addGroup(gid, owner);

    await db.doTn(async tn => {
      for (let i = 0; i < 600; i++) {
        tn.set(
          queue.ks.groupJob(gid, `0000-stale-${String(i).padStart(4, "0")}`),
          encodeJson({ m: 1, s: "pending" }),
        );
      }
    });

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
    expect(await queue.getTeamPendingCount(owner)).toBe(1);

    expect(await group.cancelGroup(gid)).toBe(true);
    await sweeper.sweepOnce();

    expect(await queue.getJob(pendingId)).toBeNull();
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    await db.doTn(async tn => {
      expect(await tn.get(queue.ks.taskGroupCancel(gid))).toBeFalsy();
    });
  });

  test("waitForJob resolves on completion and rejects on failure", async () => {
    const { queue } = await makeCtx("wait");
    const owner = freshOwner();
    const id1 = randomUUID();
    await queue.addJob(id1, scrapeData(), { ownerId: owner }, UNLIMITED);

    const wait1 = queue.waitForJob(id1, 15_000);
    const [j1] = await takeAll(queue, 1);
    await queue.jobFinish(j1.id, j1.lock!, { doc: "ok" });
    if (expectInlineReturnvalue) {
      await expect(wait1).resolves.toEqual({ doc: "ok" });
    } else {
      await expect(wait1).resolves.toBeNull();
    }

    const id2 = randomUUID();
    await queue.addJob(id2, scrapeData(), { ownerId: owner }, UNLIMITED);
    const wait2 = queue.waitForJob(id2, 15_000);
    const [j2] = await takeAll(queue, 1);
    await queue.jobFail(j2.id, j2.lock!, "scrape exploded");
    await expect(wait2).rejects.toThrow("scrape exploded");

    const id3 = randomUUID();
    await queue.addJob(id3, scrapeData(), { ownerId: owner }, UNLIMITED);
    await expect(queue.waitForJob(id3, 500)).rejects.toThrow(/timed out/i);
    const [j3] = await takeAll(queue, 1);
    await queue.jobFinish(j3.id, j3.lock!, null);
  }, 30_000);

  test("large returnvalue is chunked and reassembled (self-host path)", async () => {
    if (!expectInlineReturnvalue) return;
    const { queue } = await makeCtx("chunks");
    const owner = freshOwner();
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: owner }, UNLIMITED);
    const [job] = await takeAll(queue, 1);

    const big = { blob: "x".repeat(300 * 1024) };
    await queue.jobFinish(id, job.lock!, big);

    const j = await queue.getJob(id);
    expect(j?.status).toBe("completed");
    expect(j?.returnvalue?.blob?.length).toBe(300 * 1024);
  });

  test("getCrawlJobsForListing paginates completed jobs in finish order", async () => {
    const { queue, group } = await makeCtx("listing");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);

    const ids = Array.from({ length: 5 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, groupId: gid },
      })),
      gate(10),
    );
    const taken = await takeAll(queue, 5);
    expect(taken.length).toBe(5);
    const finishOrder: string[] = [];
    for (const j of taken) {
      await queue.jobFinish(j.id, j.lock!, null);
      finishOrder.push(j.id);
    }

    const page1 = await queue.getCrawlJobsForListing(gid, 3, 0);
    const page2 = await queue.getCrawlJobsForListing(gid, 3, 3);
    expect(page1.map(j => j.id)).toEqual(finishOrder.slice(0, 3));
    expect(page2.map(j => j.id)).toEqual(finishOrder.slice(3));
  });

  test("getGroupAnyJob returns a single_urls member and checks ownership", async () => {
    const { queue, group } = await makeCtx("anyjob");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);
    const id = randomUUID();
    await queue.addJob(
      id,
      scrapeData(),
      { ownerId: owner, groupId: gid },
      gate(10),
    );

    const any = await queue.getGroupAnyJob(gid, owner);
    expect(any?.id).toBe(id);
    expect(await queue.getGroupAnyJob(gid, randomUUID())).toBeNull();

    const [j] = await takeAll(queue, 1);
    await queue.jobFinish(j.id, j.lock!, null);
  });

  // A completed crawl member must retain its input data so the crawl-finish job
  // can recover crawl-scoped context (v1, webhook, team_id) via getGroupAnyJob,
  // matching the PG backend. Cloud sheds standalone data but not group members.
  test("group member retains input data after completion", async () => {
    const { queue, group } = await makeCtx("retain-groupdata");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);
    const id = randomUUID();
    await queue.addJob(
      id,
      scrapeData({ v1: true, team_id: owner, webhook: { url: "https://wh" } }),
      { ownerId: owner, groupId: gid },
      gate(10),
    );

    const [j] = await takeAll(queue, 1);
    await queue.jobFinish(j.id, j.lock!, { ok: true });

    const any = await queue.getGroupAnyJob(gid, owner);
    expect(any?.id).toBe(id);
    expect(any?.data).not.toBeNull();
    expect(any?.data?.v1).toBe(true);
    expect(any?.data?.webhook?.url).toBe("https://wh");
  });

  // ZDR members still shed input data on completion (compliance), so the
  // crawl-finish path must tolerate null data for those crawls.
  test("ZDR group member sheds input data on completion", async () => {
    const { queue, group } = await makeCtx("zdr-shed");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);
    const id = randomUUID();
    await queue.addJob(
      id,
      scrapeData({ zeroDataRetention: true }),
      { ownerId: owner, groupId: gid },
      gate(10),
    );

    const [j] = await takeAll(queue, 1);
    await queue.jobFinish(j.id, j.lock!, null);

    const got = await queue.getJob(id);
    expect(got?.data).toBeNull();
  });

  test("removeJob releases slots and promotes backlog", async () => {
    const { queue } = await makeCtx("remove");
    const owner = freshOwner();
    const a = randomUUID();
    const b = randomUUID();
    await queue.addJob(a, scrapeData(), { ownerId: owner }, gate(1));
    await queue.addJob(
      b,
      scrapeData(),
      { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      gate(1),
    );
    expect(await queue.getTeamPendingCount(owner)).toBe(1);

    // removing the slot-holding job promotes the backlogged one
    expect(await queue.removeJob(a)).toBe(true);
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    expect(await queue.getJob(a)).toBeNull();

    const [j] = await takeAll(queue, 1);
    expect(j.id).toBe(b);
    await queue.jobFinish(j.id, j.lock!, null);
  });

  test("limit raise promotes backlogged jobs via the sweeper", async () => {
    const { queue, sweeper } = await makeCtx("raise");
    const owner = freshOwner();
    const ids = Array.from({ length: 4 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      })),
      gate(1),
    );
    expect(await queue.getTeamActiveCount(owner)).toBe(1);
    expect(await queue.getTeamPendingCount(owner)).toBe(3);

    // a later enqueue arrives with a raised limit (ACUC change)
    await queue.addJob(
      randomUUID(),
      scrapeData(),
      { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      gate(4),
    );
    await sweeper.sweepOnce();

    expect(await queue.getTeamActiveCount(owner)).toBe(4);
    expect(await queue.getTeamPendingCount(owner)).toBe(1);

    const taken = await takeAll(queue, 4);
    expect(taken.length).toBe(4);
    for (const j of taken) await queue.jobFinish(j.id, j.lock!, null);
    const [last] = await takeAll(queue, 1);
    await queue.jobFinish(last.id, last.lock!, null);
  });

  test("group TTL cleanup removes job records", async () => {
    const { queue, group, sweeper } = await makeCtx("gttl");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner, 1000); // 1s TTL

    const id = randomUUID();
    await queue.addJob(
      id,
      scrapeData(),
      { ownerId: owner, groupId: gid },
      gate(10),
    );
    const [j] = await takeAll(queue, 1);
    await queue.jobFinish(j.id, j.lock!, null);

    expect((await group.getGroup(gid))?.status).toBe("completed");
    await new Promise(resolve => setTimeout(resolve, 1100));
    await sweeper.sweepOnce();

    expect(await group.getGroup(gid)).toBeNull();
    expect(await queue.getJob(id)).toBeNull();
  });
});
