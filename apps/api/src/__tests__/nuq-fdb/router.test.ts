import { randomUUID } from "crypto";
import { vi } from "vitest";
import { config } from "../../config";
import { redisEvictConnection } from "../../services/redis";
import {
  fdbQueueEnabled,
  isFdbTeam,
  resolveJobBackend,
  resolveNewGroupBackend,
  fdbEnqueueScrapeJobs,
  scrapeQueue,
  crawlGroup,
  crawlFinishedQueue,
  mirrorExternalSlotAcquire,
  mirrorExternalSlotRelease,
} from "../../services/worker/nuq-router";
import { scrapeQueueFdb } from "../../services/worker/nuq-fdb";
import {
  getNuqFdbDatabase,
  getFdb,
} from "../../services/worker/nuq-fdb/client";

// Exercises the dual-backend router in forced-FDB mode (NUQ_BACKEND=fdb,
// self-hosted), which needs neither ACUC nor a PG nuq database: everything
// must route to FDB and never touch the PG pool. Requires a live FDB cluster.
const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;

const prevNuqBackend = config.NUQ_BACKEND;
const prevDbAuth = config.USE_DB_AUTHENTICATION;

describeIf("NuQ router (forced FDB mode)", () => {
  beforeAll(() => {
    config.NUQ_BACKEND = "fdb";
    config.USE_DB_AUTHENTICATION = false; // self-hosted: unlimited concurrency
  });

  afterAll(async () => {
    config.NUQ_BACKEND = prevNuqBackend;
    config.USE_DB_AUTHENTICATION = prevDbAuth;
    // forced mode writes into the real "scrape"/"crawl_finished" queue
    // namespaces; wipe them so reruns and other suites start clean
    const fdb = getFdb();
    const db = getNuqFdbDatabase();
    for (const name of ["scrape", "crawl_finished"]) {
      const r = fdb.tuple.range(["nuq", name]);
      await db.doTn(async tn =>
        tn.clearRange(r.begin as Buffer, r.end as Buffer),
      );
    }
  });

  test("routing decisions resolve to fdb when forced", async () => {
    expect(fdbQueueEnabled()).toBe(true);
    expect(await isFdbTeam(randomUUID())).toBe(true);
    expect(await resolveNewGroupBackend(randomUUID())).toBe("fdb");
    expect(
      await resolveJobBackend({
        mode: "single_urls",
        url: "https://example.com",
        team_id: randomUUID(),
      } as any),
    ).toBe("fdb");
  });

  test("enqueue -> routed take -> routed finish -> routed waitForJob, all on FDB", async () => {
    const teamId = randomUUID();
    const jobId = randomUUID();
    const { jobs, backloggedCount } = await fdbEnqueueScrapeJobs(
      [
        {
          jobId,
          data: {
            mode: "single_urls",
            url: "https://example.com",
            team_id: teamId,
          } as any,
          priority: 0,
          backlogTimeoutMs: 60_000,
        },
      ],
      teamId,
    );
    expect(jobs[0].backend).toBe("fdb");
    expect(jobs[0].status).toBe("queued"); // self-hosted: no gate
    expect(backloggedCount).toBe(0);

    const wait = scrapeQueue.waitForJob(jobId, 15_000);

    // routed take must find the FDB job without ever polling PG (no PG here)
    let taken: any = null;
    for (let i = 0; i < 10 && !taken; i++) {
      try {
        taken = await scrapeQueue.getJobToProcess();
      } catch {
        // PG fallback poll can throw without a database; FDB must still win
      }
    }
    expect(taken).not.toBeNull();
    expect(taken.id).toBe(jobId);
    expect((taken as any).backend).toBe("fdb");

    expect(await scrapeQueue.renewLock(jobId, taken.lock!)).toBe(true);
    expect(await scrapeQueue.jobFinish(jobId, taken.lock!, { ok: true })).toBe(
      true,
    );

    await expect(wait).resolves.toBeDefined();

    const job = await scrapeQueue.getJob(jobId);
    expect(job?.status).toBe("completed");
    const jobsRead = await scrapeQueue.getJobs([jobId]);
    expect(jobsRead.length).toBe(1);
  });

  test("optional FDB waitForJob uses caller timeout, not the quick optional-op timeout", async () => {
    const forcedBackend = config.NUQ_BACKEND;
    const redisGet = vi.spyOn(redisEvictConnection, "get");
    const redisSet = vi.spyOn(redisEvictConnection, "set");
    config.NUQ_BACKEND = "pg";
    try {
      const teamId = randomUUID();
      const jobId = randomUUID();
      redisGet.mockImplementation(async key =>
        key === `nuq:job_backend:${jobId}` ? "fdb" : null,
      );
      redisSet.mockResolvedValue("OK" as any);

      const { jobs, backloggedCount } = await fdbEnqueueScrapeJobs(
        [
          {
            jobId,
            data: {
              mode: "single_urls",
              url: "https://example.com",
              team_id: teamId,
            } as any,
            priority: 0,
            listenable: true,
            backlogTimeoutMs: 60_000,
          },
        ],
        teamId,
      );
      expect(jobs[0].backend).toBe("fdb");
      expect(backloggedCount).toBe(0);

      const wait = scrapeQueue.waitForJob(jobId, 15_000);

      await new Promise(resolve => setTimeout(resolve, 800));

      const taken = await scrapeQueueFdb.getJobToProcess();
      expect(taken?.id).toBe(jobId);
      await scrapeQueueFdb.jobFinish(jobId, taken!.lock!, { ok: true });

      await expect(wait).resolves.toBeDefined();
    } finally {
      config.NUQ_BACKEND = forcedBackend;
      redisGet.mockRestore();
      redisSet.mockRestore();
    }
  });

  test("routed group lifecycle incl. crawl_finished consumption and cancel", async () => {
    const teamId = randomUUID();
    const gid = randomUUID();
    const group = await crawlGroup.addGroup(gid, teamId, 60_000, {
      backend: "fdb",
    });
    expect(group.status).toBe("active");
    expect((await crawlGroup.getGroup(gid))?.id).toBe(gid);

    const jobId = randomUUID();
    await fdbEnqueueScrapeJobs(
      [
        {
          jobId,
          data: {
            mode: "single_urls",
            url: "https://example.com",
            team_id: teamId,
            crawl_id: gid,
          } as any,
          priority: 0,
          backlogTimeoutMs: 60_000,
        },
      ],
      teamId,
    );

    let taken: any = null;
    for (let i = 0; i < 10 && !taken; i++) {
      try {
        taken = await scrapeQueue.getJobToProcess();
      } catch {}
    }
    expect(taken?.id).toBe(jobId);
    await scrapeQueue.jobFinish(jobId, taken.lock!, null);

    expect((await crawlGroup.getGroup(gid))?.status).toBe("completed");
    expect(await scrapeQueue.getGroupNumericStats(gid)).toMatchObject({
      completed: 1,
    });
    const listing = await scrapeQueue.getCrawlJobsForListing(gid, 10, 0);
    expect(listing.map(j => j.id)).toEqual([jobId]);

    // the emitted crawl_finished job is consumable through the router
    let fin: any = null;
    for (let i = 0; i < 10 && !fin; i++) {
      try {
        fin = await crawlFinishedQueue.getJobToProcess();
      } catch {}
    }
    expect(fin).not.toBeNull();
    expect(fin.groupId).toBe(gid);
    expect(await crawlFinishedQueue.jobFinish(fin.id, fin.lock!, null)).toBe(
      true,
    );

    // cancel on an already-completed group is a no-op
    expect(await crawlGroup.cancelGroup(gid)).toBe(false);
  });

  test("external slot mirror consumes and releases FDB capacity", async () => {
    const teamId = randomUUID();
    const holder = randomUUID();
    await mirrorExternalSlotAcquire(teamId, holder, 30_000);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
    // re-acquire (heartbeat) must not double-count
    await mirrorExternalSlotAcquire(teamId, holder, 30_000);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
    await mirrorExternalSlotRelease(teamId, holder);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
    // double release is a no-op
    await mirrorExternalSlotRelease(teamId, holder);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
  });
});
