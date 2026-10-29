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
import { decodeI64 } from "../../services/worker/nuq-fdb/keyspace";

// API-key concurrency gate tests, run directly against a real FoundationDB
// cluster like core.test.ts. Skipped when FDB is not configured.
const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;

const RUN = randomUUID().slice(0, 8);
const TEST_LEASE_MS = 1500;

const createdQueueNames: string[] = [];

type Ctx = {
  queue: NuQFdbQueue;
  group: NuQFdbJobGroup;
  sweeper: NuqFdbSweeper;
};

async function makeCtx(name: string): Promise<Ctx> {
  const scrapeName = `tk-${RUN}-${name}`;
  const finishedName = `tk-${RUN}-${name}-fin`;
  createdQueueNames.push(scrapeName, finishedName);
  const queue = new NuQFdbQueue(scrapeName, {
    hasGroups: true,
    finishedQueueName: finishedName,
    leaseMs: TEST_LEASE_MS,
  });
  const finishedQueue = new NuQFdbQueue(finishedName, { hasGroups: false });
  const group = new NuQFdbJobGroup(queue.ks, queue.groupOps!);
  const sweeper = new NuqFdbSweeper([queue, finishedQueue]);
  return { queue, group, sweeper };
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

function scrapeData(): any {
  return { mode: "single_urls", url: "https://example.com" };
}

const kgate = (
  teamLimit: number,
  keyId: string,
  keyLimit: number,
  cap: number = 1_000_000,
) => ({
  teamLimit,
  queueCap: cap,
  key: { id: keyId, limit: keyLimit },
});

async function keyActiveCount(queue: NuQFdbQueue, kid: string) {
  return await getNuqFdbDatabase().doTn(async tn =>
    decodeI64(await tn.get(queue.ks.keyActive(kid))),
  );
}

function jobInput(owner: string, groupId?: string) {
  return {
    id: randomUUID(),
    data: scrapeData(),
    options: {
      ownerId: owner,
      groupId,
      timesOutAt: new Date(Date.now() + 60_000),
    },
  };
}

describeIf("NuQ FDB API-key gate", () => {
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

  test("key limit 2 admits 2, backlogs the rest, hands off on finish", async () => {
    const { queue } = await makeCtx("basic");
    const owner = freshOwner();
    const kid = randomUUID();
    const jobs = await queue.addJobs(
      Array.from({ length: 5 }, () => jobInput(owner)),
      kgate(10, kid, 2),
    );

    // the team would admit all 5; the key admits only 2
    expect(jobs.filter(j => j.status === "queued").length).toBe(2);
    expect(jobs.filter(j => j.status === "backlog").length).toBe(3);
    expect(await queue.getTeamActiveCount(owner)).toBe(2);
    expect(await queue.getTeamPendingCount(owner)).toBe(3);
    expect(await keyActiveCount(queue, kid)).toBe(2);

    const taken = await takeAll(queue, 5);
    expect(taken.length).toBe(2);

    // finishing one job hands its key slot to exactly one backlogged job
    await queue.jobFinish(taken[0].id, taken[0].lock!, null);
    expect(await keyActiveCount(queue, kid)).toBe(2);
    expect(await queue.getTeamActiveCount(owner)).toBe(2);
    expect(await queue.getTeamPendingCount(owner)).toBe(2);

    const next = await takeAll(queue, 5);
    expect(next.length).toBe(1);

    // drain everything; counters return to zero
    let inflight = [taken[1], ...next];
    while (inflight.length > 0) {
      for (const j of inflight) await queue.jobFinish(j.id, j.lock!, null);
      inflight = await takeAll(queue, 5);
    }
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    expect(await keyActiveCount(queue, kid)).toBe(0);
  });

  test("key gate cascades inside the crawl gate", async () => {
    const { queue, group } = await makeCtx("cascade");
    const owner = freshOwner();
    const kid = randomUUID();
    const gid = randomUUID();
    await group.addGroup(gid, owner, undefined, { maxConcurrency: 3 });

    await queue.addJobs(
      Array.from({ length: 6 }, () => jobInput(owner, gid)),
      kgate(10, kid, 2),
    );

    // crawl admits 3, key admits 2 of those: 2 ready, 1 key-pending,
    // 3 crawl-pending
    expect(await queue.getTeamActiveCount(owner)).toBe(2);
    expect(await keyActiveCount(queue, kid)).toBe(2);

    // the key limit stays the ceiling while all 6 jobs drain through
    let finished = 0;
    let inflight = await takeAll(queue, 6);
    expect(inflight.length).toBe(2);
    while (inflight.length > 0) {
      expect(inflight.length).toBeLessThanOrEqual(2);
      for (const j of inflight) {
        await queue.jobFinish(j.id, j.lock!, null);
        finished++;
      }
      expect(await keyActiveCount(queue, kid)).toBeLessThanOrEqual(2);
      inflight = await takeAll(queue, 6);
    }
    expect(finished).toBe(6);

    const g = await group.getGroup(gid);
    expect(g?.status).toBe("completed");
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
    expect(await keyActiveCount(queue, kid)).toBe(0);
  });

  test("key limit raise promotes backlogged jobs via the sweeper", async () => {
    const { queue, sweeper } = await makeCtx("raise");
    const owner = freshOwner();
    const kid = randomUUID();
    await queue.addJobs(
      Array.from({ length: 3 }, () => jobInput(owner)),
      kgate(10, kid, 1),
    );
    expect(await queue.getTeamActiveCount(owner)).toBe(1);
    expect(await queue.getTeamPendingCount(owner)).toBe(2);

    // a later enqueue arrives with a raised key limit
    await queue.addJob(
      randomUUID(),
      scrapeData(),
      { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      kgate(10, kid, 3),
    );
    await sweeper.sweepOnce();

    expect(await queue.getTeamActiveCount(owner)).toBe(3);
    expect(await queue.getTeamPendingCount(owner)).toBe(1);
    expect(await keyActiveCount(queue, kid)).toBe(3);

    let inflight = await takeAll(queue, 4);
    expect(inflight.length).toBe(3);
    let total = 0;
    while (inflight.length > 0) {
      for (const j of inflight) {
        await queue.jobFinish(j.id, j.lock!, null);
        total++;
      }
      inflight = await takeAll(queue, 4);
    }
    expect(total).toBe(4);
    expect(await keyActiveCount(queue, kid)).toBe(0);
  });

  test("two keys gate independently under one team", async () => {
    const { queue } = await makeCtx("twokeys");
    const owner = freshOwner();
    const kid1 = randomUUID();
    const kid2 = randomUUID();

    await queue.addJobs(
      Array.from({ length: 2 }, () => jobInput(owner)),
      kgate(10, kid1, 1),
    );
    await queue.addJobs(
      Array.from({ length: 2 }, () => jobInput(owner)),
      kgate(10, kid2, 1),
    );

    expect(await queue.getTeamActiveCount(owner)).toBe(2);
    expect(await keyActiveCount(queue, kid1)).toBe(1);
    expect(await keyActiveCount(queue, kid2)).toBe(1);

    const taken = await takeAll(queue, 4);
    expect(taken.length).toBe(2);

    // finishing one key's job promotes that key's backlog only
    await queue.jobFinish(taken[0].id, taken[0].lock!, null);
    expect(await keyActiveCount(queue, kid1)).toBe(1);
    expect(await keyActiveCount(queue, kid2)).toBe(1);
    expect(await queue.getTeamPendingCount(owner)).toBe(1);

    await queue.jobFinish(taken[1].id, taken[1].lock!, null);
    let inflight = await takeAll(queue, 4);
    let total = 2; // 2 taken initially
    while (inflight.length > 0) {
      total += inflight.length;
      for (const j of inflight) await queue.jobFinish(j.id, j.lock!, null);
      inflight = await takeAll(queue, 4);
    }
    expect(total).toBe(4);
    expect(await keyActiveCount(queue, kid1)).toBe(0);
    expect(await keyActiveCount(queue, kid2)).toBe(0);
  });

  test("removing a team-pending job hands its key slot to the key backlog", async () => {
    const { queue } = await makeCtx("remove");
    const owner = freshOwner();
    const kid = randomUUID();
    // team 1, key 2: A ready (team+key), B team-pending (holds key),
    // C key-pending
    const inputs = Array.from({ length: 3 }, () => jobInput(owner));
    const jobs = await queue.addJobs(inputs, kgate(1, kid, 2));
    const a = jobs.find(j => j.status === "queued")!;
    expect(await keyActiveCount(queue, kid)).toBe(2);
    expect(await queue.getTeamPendingCount(owner)).toBe(2);

    // jobs are placed in input order: jobs[1] is the team-pending one (it
    // won the second key slot), jobs[2] waits in the key gate
    const b = jobs[1];
    expect(b.status).toBe("backlog");
    await queue.removeJob(b.id);
    // its key slot moved to the key-pending job; nothing ran yet, so the
    // key active count is unchanged and one job still waits for the team
    expect(await keyActiveCount(queue, kid)).toBe(2);
    expect(await queue.getTeamPendingCount(owner)).toBe(1);

    const [takenA] = await takeAll(queue, 2);
    expect(takenA.id).toBe(a.id);
    await queue.jobFinish(takenA.id, takenA.lock!, null);

    const [takenC] = await takeAll(queue, 2);
    expect(takenC).toBeDefined();
    await queue.jobFinish(takenC.id, takenC.lock!, null);

    expect(await queue.getTeamActiveCount(owner)).toBe(0);
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    expect(await keyActiveCount(queue, kid)).toBe(0);
  });

  test("key-pending jobs are silently dropped at their backlog deadline", async () => {
    const { queue, sweeper } = await makeCtx("bto");
    const owner = freshOwner();
    const kid = randomUUID();
    const inputs = Array.from({ length: 3 }, () => ({
      id: randomUUID(),
      data: scrapeData(),
      options: {
        ownerId: owner,
        timesOutAt: new Date(Date.now() + 1000),
      },
    }));
    const jobs = await queue.addJobs(inputs, kgate(10, kid, 1));
    expect(jobs.filter(j => j.status === "backlog").length).toBe(2);

    await new Promise(resolve => setTimeout(resolve, 1200));
    await sweeper.sweepOnce();

    // the two key-pending jobs are gone; the running one is unaffected
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    expect(await keyActiveCount(queue, kid)).toBe(1);
    for (const j of jobs.filter(j => j.status === "backlog")) {
      expect(await queue.getJob(j.id)).toBeNull();
    }

    const taken = await takeAll(queue, 3);
    expect(taken.length).toBe(1);
    await queue.jobFinish(taken[0].id, taken[0].lock!, null);
    expect(await keyActiveCount(queue, kid)).toBe(0);
  });

  test("crawl delay wake-up passes through the key gate", async () => {
    const { queue, group, sweeper } = await makeCtx("delay");
    const owner = freshOwner();
    const kid = randomUUID();
    const gid = randomUUID();
    await group.addGroup(gid, owner, undefined, { delaySeconds: 1 });

    const inputs = [jobInput(owner, gid), jobInput(owner, gid)];
    await queue.addJobs(inputs, kgate(10, kid, 1));

    const [first] = await takeAll(queue, 2);
    expect(first).toBeDefined();
    await queue.jobFinish(first.id, first.lock!, null);
    // the second job is parked in the delay index holding only its crawl
    // slot; the finished job's key slot was released
    expect(await keyActiveCount(queue, kid)).toBe(0);

    await sweeper.sweepOnce();
    expect(await queue.getJobToProcess()).toBeNull();

    await new Promise(resolve => setTimeout(resolve, 1200));
    await sweeper.sweepOnce();
    // the wake-up acquired the key slot again
    expect(await keyActiveCount(queue, kid)).toBe(1);
    const [second] = await takeAll(queue, 1);
    expect(second).toBeDefined();
    await queue.jobFinish(second.id, second.lock!, null);
    expect(await keyActiveCount(queue, kid)).toBe(0);

    const g = await group.getGroup(gid);
    expect(g?.status).toBe("completed");
  });
});
