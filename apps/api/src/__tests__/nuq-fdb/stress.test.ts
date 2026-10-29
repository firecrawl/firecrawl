import { randomUUID } from "crypto";
import { config } from "../../config";
import { NuQFdbQueue, NuQFdbJobGroup } from "../../services/worker/nuq-fdb";
import {
  getNuqFdbDatabase,
  getFdb,
} from "../../services/worker/nuq-fdb/client";

const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;

const RUN = randomUUID().slice(0, 8);

describeIf("NuQ FDB concurrency stress", () => {
  const queueNames: string[] = [];

  afterAll(async () => {
    const fdb = getFdb();
    const db = getNuqFdbDatabase();
    for (const name of queueNames) {
      const r = fdb.tuple.range(["nuq", name]);
      await db.doTn(async tn =>
        tn.clearRange(r.begin as Buffer, r.end as Buffer),
      );
    }
  });

  test("parallel workers never exceed the team limit and drain everything", async () => {
    const name = `t-${RUN}-stress`;
    queueNames.push(name);
    const queue: NuQFdbQueue = new NuQFdbQueue(name, { hasGroups: true });

    const owner = randomUUID();
    const LIMIT = 5;
    const JOBS = 60;
    const WORKERS = 12;
    const gate = { teamLimit: LIMIT, queueCap: 1_000_000 };

    await queue.addJobs(
      Array.from({ length: JOBS }, () => ({
        id: randomUUID(),
        data: { mode: "single_urls", url: "https://example.com" },
        options: {
          ownerId: owner,
          timesOutAt: new Date(Date.now() + 120_000),
        },
      })),
      gate,
    );

    expect(await queue.getTeamActiveCount(owner)).toBe(LIMIT);
    expect(await queue.getTeamPendingCount(owner)).toBe(JOBS - LIMIT);

    let inFlight = 0;
    let maxInFlight = 0;
    let processed = 0;
    const seen = new Set<string>();

    // simulated workers: take, hold briefly, finish
    const worker = async () => {
      let idleStrikes = 0;
      while (idleStrikes < 8) {
        const job = await queue.getJobToProcess();
        if (!job) {
          idleStrikes++;
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        idleStrikes = 0;
        expect(seen.has(job.id)).toBe(false);
        seen.add(job.id);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve =>
          setTimeout(resolve, 10 + Math.random() * 30),
        );
        inFlight--;
        const ok = await queue.jobFinish(job.id, job.lock!, null);
        expect(ok).toBe(true);
        processed++;
      }
    };

    await Promise.all(Array.from({ length: WORKERS }, () => worker()));

    expect(processed).toBe(JOBS);
    expect(maxInFlight).toBeLessThanOrEqual(LIMIT);
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
  }, 120_000);

  test("parallel enqueuers + workers with a crawl gate stay within both limits", async () => {
    const name = `t-${RUN}-stress2`;
    queueNames.push(name);
    const queue: NuQFdbQueue = new NuQFdbQueue(name, {
      hasGroups: true,
      finishedQueueName: `${name}-fin`,
    });
    queueNames.push(`${name}-fin`);
    const finishedQueue: NuQFdbQueue = new NuQFdbQueue(`${name}-fin`, {
      hasGroups: false,
    });
    const group = new NuQFdbJobGroup(queue.ks, queue.groupOps!);

    const owner = randomUUID();
    const gid = randomUUID();
    const CRAWL_LIMIT = 3;
    const TEAM_LIMIT = 10;
    const JOBS = 40;
    const gate = { teamLimit: TEAM_LIMIT, queueCap: 1_000_000 };
    await group.addGroup(gid, owner, undefined, {
      maxConcurrency: CRAWL_LIMIT,
    });

    // enqueue from 4 parallel producers while workers consume
    const producers = Array.from({ length: 4 }, (_, p) =>
      queue.addJobs(
        Array.from({ length: JOBS / 4 }, () => ({
          id: randomUUID(),
          data: { mode: "single_urls", url: "https://example.com" },
          options: {
            ownerId: owner,
            groupId: gid,
            timesOutAt: new Date(Date.now() + 120_000),
          },
        })),
        gate,
      ),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    let processed = 0;
    const worker = async () => {
      let idleStrikes = 0;
      while (idleStrikes < 10) {
        const job = await queue.getJobToProcess();
        if (!job) {
          idleStrikes++;
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        idleStrikes = 0;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve =>
          setTimeout(resolve, 5 + Math.random() * 20),
        );
        inFlight--;
        await queue.jobFinish(job.id, job.lock!, null);
        processed++;
      }
    };

    const [results] = await Promise.all([
      Promise.all(producers),
      ...Array.from({ length: 6 }, () => worker()),
    ]);
    expect(results.flat().length).toBe(JOBS);
    expect(processed).toBe(JOBS);
    expect(maxInFlight).toBeLessThanOrEqual(CRAWL_LIMIT);

    // the group drained, so it must have completed and emitted exactly one
    // crawl_finished job even under concurrent finishers
    const g = await group.getGroup(gid);
    expect(g?.status).toBe("completed");
    const fin = await finishedQueue.getJobToProcess();
    expect(fin).not.toBeNull();
    expect(await finishedQueue.getJobToProcess()).toBeNull();

    const stats = await queue.getGroupNumericStats(gid);
    expect(stats.completed).toBe(JOBS);
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
    expect(stats.backlog).toBe(0);
  }, 120_000);
});
