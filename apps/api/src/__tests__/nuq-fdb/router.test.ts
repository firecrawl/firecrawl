import { randomUUID } from "crypto";
import { vi } from "vitest";

// This suite only exercises the routed FDB implementation. Keeping the PG
// queue mocked avoids pulling scraper engine build artifacts into the focused
// FoundationDB CI job.
vi.mock("../../services/worker/nuq", () => {
  const queue = {
    getJobToProcess: vi.fn().mockResolvedValue(null),
  };
  return {
    scrapeQueue: queue,
    crawlFinishedQueue: queue,
    crawlGroup: {},
  };
});
vi.mock("../../services/ab-test", () => ({
  abTestJob: vi.fn(),
}));
vi.mock("../../lib/crawl-redis", () => ({
  getCrawl: vi.fn(),
}));
vi.mock("../../services/redlock", () => ({
  redlock: {
    using: vi.fn(
      async (
        _resources: string[],
        _duration: number,
        _options: object,
        fn: (signal: { aborted: boolean; error?: Error }) => unknown,
      ) => await fn({ aborted: false }),
    ),
  },
}));

import { config } from "../../config";
import { redisEvictConnection } from "../../services/redis";
import { getRedisConnection } from "../../services/queue-service";
import {
  fdbQueueEnabled,
  isFdbTeam,
  resolveJobBackend,
  resolveNewGroupBackend,
  fdbEnqueueScrapeJobs,
  getCombinedTeamActiveCount,
  scrapeQueue,
  crawlGroup,
  crawlFinishedQueue,
  mirrorExternalSlotAcquire,
  mirrorExternalSlotRelease,
  reserveExternalSlot,
} from "../../services/worker/nuq-router";
import { waitForJob as waitForQueuedJob } from "../../services/queue-jobs";
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

  test("marker failure or expiry cannot hide standalone FDB jobs", async () => {
    const forcedBackend = config.NUQ_BACKEND;
    const redisGet = vi.spyOn(redisEvictConnection, "get");
    const redisSet = vi.spyOn(redisEvictConnection, "set");
    config.NUQ_BACKEND = "pg";
    try {
      const teamId = randomUUID();
      const jobId = randomUUID();
      redisGet.mockResolvedValue(null);
      redisSet.mockImplementation(async key => {
        if (key === `nuq:fdb_team:${teamId}`) return "OK" as any;
        throw new Error("marker unavailable");
      });

      const { jobs } = await fdbEnqueueScrapeJobs(
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

      // The returned backend survives queue-jobs and can route a wait without
      // consulting Redis. ID-only reads/removes recover from durable FDB state.
      expect(jobs[0].backend).toBe("fdb");
      expect((await scrapeQueue.getJob(jobId))?.id).toBe(jobId);
      const wait = waitForQueuedJob(jobs[0], 15_000, false);
      const taken = await scrapeQueueFdb.getJobToProcess();
      expect(taken?.id).toBe(jobId);
      await scrapeQueueFdb.jobFinish(jobId, taken!.lock!, { ok: true });
      await expect(wait).resolves.toEqual({ ok: true });
      await scrapeQueue.removeJob(jobId);

      const cancelId = randomUUID();
      await fdbEnqueueScrapeJobs(
        [
          {
            jobId: cancelId,
            data: {
              mode: "single_urls",
              url: "https://example.com/cancel",
              team_id: teamId,
            } as any,
            priority: 0,
            backlogTimeoutMs: 60_000,
          },
        ],
        teamId,
      );
      // ID-only standalone cancellation also probes durable FDB state.
      await scrapeQueue.removeJob(cancelId);
      expect(await scrapeQueue.getJob(cancelId)).toBeNull();
    } finally {
      config.NUQ_BACKEND = forcedBackend;
      redisGet.mockRestore();
      redisSet.mockRestore();
    }
  });

  test("repeated enqueue reconciles a late commit by stable job id", async () => {
    const teamId = randomUUID();
    const jobId = randomUUID();
    const input = {
      id: jobId,
      data: {
        mode: "single_urls",
        url: "https://example.com",
        team_id: teamId,
      } as any,
      options: {
        ownerId: teamId,
        priority: 0,
        bypassGate: true,
      },
    };

    const first = await scrapeQueueFdb.addJobs([input], {
      teamLimit: 1,
      queueCap: 10,
    });
    const retried = await scrapeQueueFdb.addJobs([input], {
      teamLimit: 1,
      queueCap: 10,
    });
    expect(first[0].id).toBe(jobId);
    expect(retried[0].id).toBe(jobId);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
    await scrapeQueueFdb.removeJob(jobId);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
  });

  test("PG occupancy reduces FDB admission and direct jobs keep occupancy parity", async () => {
    const teamId = randomUUID();
    const blockedId = randomUUID();
    const directId = randomUUID();
    const data = {
      mode: "single_urls",
      url: "https://example.com",
      team_id: teamId,
    } as any;

    const blocked = await scrapeQueueFdb.addJob(
      blockedId,
      data,
      { ownerId: teamId, priority: 0 },
      { teamLimit: 2, externalActive: 2, queueCap: 10 },
    );
    expect(blocked.status).toBe("backlog");
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
    await scrapeQueueFdb.removeJob(blockedId);

    const direct = await scrapeQueueFdb.addJob(
      directId,
      data,
      { ownerId: teamId, priority: 0, bypassGate: true },
      { teamLimit: 1, queueCap: 10 },
    );
    expect(direct.status).toBe("queued");
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
    await scrapeQueueFdb.removeJob(directId);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
  });

  test("flag rollback keeps crawl jobs pinned to their durable FDB group", async () => {
    const forcedBackend = config.NUQ_BACKEND;
    const redisGet = vi.spyOn(redisEvictConnection, "get");
    const redisStateGet = vi.spyOn(getRedisConnection(), "get");
    const redisCount = vi.spyOn(getRedisConnection(), "zcount");
    const teamId = randomUUID();
    const groupId = randomUUID();
    const holderId = randomUUID();
    try {
      await crawlGroup.addGroup(groupId, teamId, 60_000, { backend: "fdb" });
      await mirrorExternalSlotAcquire(teamId, holderId, 60_000);
      config.NUQ_BACKEND = "pg";
      redisGet.mockResolvedValue(null);
      redisStateGet.mockImplementation(async key =>
        key === `nuq:fdb_team:${teamId}` ? "1" : null,
      );
      redisCount.mockResolvedValue(0);

      await expect(getCombinedTeamActiveCount(teamId)).resolves.toBe(1);
      await mirrorExternalSlotRelease(teamId, holderId);
      await expect(getCombinedTeamActiveCount(teamId)).resolves.toBe(0);
      await expect(
        resolveJobBackend({
          mode: "single_urls",
          url: "https://example.com",
          team_id: teamId,
          crawl_id: groupId,
        } as any),
      ).resolves.toBe("fdb");
      await expect(crawlGroup.cancelGroup(groupId)).resolves.toBe(true);
    } finally {
      config.NUQ_BACKEND = forcedBackend;
      redisGet.mockRestore();
      redisStateGet.mockRestore();
      redisCount.mockRestore();
    }
  });

  test("forced-cloud external-only occupancy survives rollback", async () => {
    const forcedBackend = config.NUQ_BACKEND;
    const previousDbAuth = config.USE_DB_AUTHENTICATION;
    const redisStateSet = vi
      .spyOn(getRedisConnection(), "set")
      .mockResolvedValue("OK");
    const redisStateGet = vi.spyOn(getRedisConnection(), "get");
    const redisCount = vi
      .spyOn(getRedisConnection(), "zcount")
      .mockResolvedValue(0);
    const teamId = randomUUID();
    const holderId = randomUUID();
    try {
      config.NUQ_BACKEND = "fdb";
      config.USE_DB_AUTHENTICATION = true;
      await mirrorExternalSlotAcquire(teamId, holderId, 60_000);
      expect(redisStateSet).toHaveBeenCalledWith(`nuq:fdb_team:${teamId}`, "1");

      config.NUQ_BACKEND = "pg";
      config.USE_DB_AUTHENTICATION = false;
      redisStateGet.mockImplementation(async key =>
        key === `nuq:fdb_team:${teamId}` ? "1" : null,
      );
      await expect(getCombinedTeamActiveCount(teamId)).resolves.toBe(1);
      await mirrorExternalSlotRelease(teamId, holderId);
      await expect(getCombinedTeamActiveCount(teamId)).resolves.toBe(0);
    } finally {
      config.NUQ_BACKEND = forcedBackend;
      config.USE_DB_AUTHENTICATION = previousDbAuth;
      redisStateSet.mockRestore();
      redisStateGet.mockRestore();
      redisCount.mockRestore();
    }
  });

  test("pure PG teams avoid FDB outages while migrated teams fail closed", async () => {
    const forcedBackend = config.NUQ_BACKEND;
    const redisStateGet = vi
      .spyOn(getRedisConnection(), "get")
      .mockResolvedValue(null);
    const redisCount = vi
      .spyOn(getRedisConnection(), "zcount")
      .mockResolvedValue(0);
    const fdbCount = vi
      .spyOn(scrapeQueueFdb, "getTeamActiveCount")
      .mockRejectedValue(new Error("FDB unavailable"));
    const teamId = randomUUID();
    config.NUQ_BACKEND = "pg";
    try {
      await expect(getCombinedTeamActiveCount(teamId)).resolves.toBe(0);
      expect(fdbCount).not.toHaveBeenCalled();

      redisStateGet.mockImplementation(async key =>
        key === `nuq:fdb_team:${teamId}` ? "1" : null,
      );
      await expect(getCombinedTeamActiveCount(teamId)).rejects.toThrow(
        "FDB unavailable",
      );
    } finally {
      config.NUQ_BACKEND = forcedBackend;
      redisStateGet.mockRestore();
      redisCount.mockRestore();
      fdbCount.mockRestore();
    }
  });

  test("optional router never attempts an FDB dequeue before PG fallback", async () => {
    const forcedBackend = config.NUQ_BACKEND;
    const fdbTake = vi.spyOn(scrapeQueueFdb, "getJobToProcess");
    config.NUQ_BACKEND = "pg";
    try {
      await scrapeQueue.getJobToProcess().catch(() => null);
      expect(fdbTake).not.toHaveBeenCalled();
    } finally {
      config.NUQ_BACKEND = forcedBackend;
      fdbTake.mockRestore();
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
    const redis = getRedisConnection();
    const redisActiveCount = vi
      .spyOn(redis, "zcount")
      .mockRejectedValue(new Error("forced FDB must not read Redis active"));
    const redisPendingCount = vi
      .spyOn(redis, "zcard")
      .mockRejectedValue(new Error("forced FDB must not read Redis pending"));
    try {
      await mirrorExternalSlotAcquire(teamId, holder, 30_000);
      expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
      await expect(
        reserveExternalSlot(teamId, randomUUID(), 30_000, 1),
      ).resolves.toBe(false);
      expect(redisActiveCount).not.toHaveBeenCalled();
      expect(redisPendingCount).not.toHaveBeenCalled();
      // re-acquire (heartbeat) must not double-count
      await mirrorExternalSlotAcquire(teamId, holder, 30_000);
      expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
      await mirrorExternalSlotRelease(teamId, holder);
      expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
      const nextHolder = randomUUID();
      await expect(
        reserveExternalSlot(teamId, nextHolder, 30_000, 1),
      ).resolves.toBe(true);
      await mirrorExternalSlotRelease(teamId, nextHolder);
      // double release is a no-op
      await mirrorExternalSlotRelease(teamId, holder);
      expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
    } finally {
      redisActiveCount.mockRestore();
      redisPendingCount.mockRestore();
    }
  });
});
