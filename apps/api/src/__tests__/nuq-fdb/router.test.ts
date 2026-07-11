import { randomUUID } from "crypto";
import { vi } from "vitest";

// This suite only exercises the routed FDB implementation. Keeping the PG
// queue mocked avoids pulling scraper engine build artifacts into the focused
// FoundationDB CI job.
vi.mock("../../services/worker/nuq", () => {
  const queue = {
    getJobToProcess: vi.fn().mockResolvedValue(null),
    getJob: vi.fn().mockResolvedValue(null),
    getJobs: vi.fn().mockResolvedValue([]),
    getJobsFromBacklog: vi.fn().mockResolvedValue([]),
  };
  return {
    scrapeQueue: queue,
    crawlFinishedQueue: queue,
    crawlGroup: { getGroup: vi.fn().mockResolvedValue(null) },
    getNuQPgOwnerLiveResidue: vi.fn().mockResolvedValue({ total: 0 }),
  };
});
vi.mock("../../services/ab-test", () => ({
  abTestJob: vi.fn(),
}));
vi.mock("../../lib/crawl-redis", () => ({
  getCrawl: vi.fn(),
}));
vi.mock("../../lib/concurrency-redis", () => ({
  getTeamQueueLimit: vi.fn().mockResolvedValue(100),
  getConcurrencyLimitActiveJobsCount: vi.fn().mockResolvedValue(0),
  getConcurrencyRollbackCleanupBacklog: vi.fn().mockResolvedValue({
    total: 0,
    due: 0,
    oldestDueAt: null,
    oldestOverdueMs: 0,
  }),
  recoverConcurrencyLimitRollbacks: vi.fn().mockResolvedValue({
    read: 0,
    finalized: 0,
    fenced: 0,
    hasMore: false,
  }),
  pushConcurrencyLimitActiveJob: vi.fn().mockResolvedValue(undefined),
  removeConcurrencyLimitActiveJob: vi.fn().mockResolvedValue(undefined),
  renewConcurrencyLimitActiveJob: vi.fn().mockResolvedValue(false),
  reserveConcurrencyLimitActiveJob: vi.fn(),
  rollbackConcurrencyLimitActiveJob: vi.fn(),
  finalizeConcurrencyLimitActiveJobRollback: vi.fn(),
  constructConcurrencyLimitKey: (teamId: string) => `concurrency:${teamId}`,
}));
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
  renewExternalSlot,
  reserveExternalSlot,
} from "../../services/worker/nuq-router";
import { waitForJob as waitForQueuedJob } from "../../services/queue-jobs";
import {
  crawlFinishedQueueFdb,
  crawlGroupFdb,
  scrapeQueueFdb,
} from "../../services/worker/nuq-fdb";
import {
  getNuqFdbDatabase,
  getFdb,
} from "../../services/worker/nuq-fdb/client";
import { decodeI64 } from "../../services/worker/nuq-fdb/keyspace";

// Exercises the dual-backend router in forced-FDB mode (NUQ_BACKEND=fdb,
// self-hosted), which needs neither ACUC nor a PG nuq database: everything
// must route to FDB and never touch the PG pool. Requires a live FDB cluster.
const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;

const prevNuqBackend = config.NUQ_BACKEND;
const prevDbAuth = config.USE_DB_AUTHENTICATION;
const prevMetricsActivation = config.NUQ_FDB_METRICS_V2_ACTIVATE;

describeIf("NuQ router (forced FDB mode)", () => {
  beforeAll(async () => {
    config.NUQ_BACKEND = "fdb";
    config.USE_DB_AUTHENTICATION = false; // self-hosted: unlimited concurrency
    config.NUQ_FDB_METRICS_V2_ACTIVATE = true;
    for (const queue of [scrapeQueueFdb, crawlFinishedQueueFdb]) {
      await queue.beginMetricCounterBackfill();
      while (!(await queue.backfillMetricCounts(100))) {
        // bounded pages
      }
    }
    while (!(await crawlGroupFdb.backfillLegacyOwnerIndex(100))) {
      // bounded pages
    }
  });

  afterAll(async () => {
    config.NUQ_BACKEND = prevNuqBackend;
    config.USE_DB_AUTHENTICATION = prevDbAuth;
    config.NUQ_FDB_METRICS_V2_ACTIVATE = prevMetricsActivation;
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
    const operation = { timeoutMs: 5_000 };
    const takeSpy = vi.spyOn(scrapeQueueFdb, "getJobToProcess");
    const renewSpy = vi.spyOn(scrapeQueueFdb, "renewLock");
    const finishSpy = vi.spyOn(scrapeQueueFdb, "jobFinish");

    // routed take must find the FDB job without ever polling PG (no PG here)
    let taken: any = null;
    for (let i = 0; i < 10 && !taken; i++) {
      try {
        taken = await scrapeQueue.getJobToProcess(undefined, operation);
      } catch {
        // PG fallback poll can throw without a database; FDB must still win
      }
    }
    expect(taken).not.toBeNull();
    expect(taken.id).toBe(jobId);
    expect((taken as any).backend).toBe("fdb");
    expect(takeSpy).toHaveBeenCalledWith(expect.anything(), operation);

    expect(
      await scrapeQueue.renewLock(jobId, taken.lock!, undefined, operation),
    ).toBe(true);
    expect(renewSpy).toHaveBeenCalledWith(
      jobId,
      taken.lock!,
      expect.anything(),
      operation,
    );
    expect(
      await scrapeQueue.jobFinish(
        jobId,
        taken.lock!,
        { ok: true },
        undefined,
        operation,
      ),
    ).toBe(true);
    expect(finishSpy).toHaveBeenCalledWith(
      jobId,
      taken.lock!,
      { ok: true },
      expect.anything(),
      operation,
    );
    takeSpy.mockRestore();
    renewSpy.mockRestore();
    finishSpy.mockRestore();

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

      config.NUQ_BACKEND = "pg";
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
    try {
      const teamId = randomUUID();
      const jobId = randomUUID();
      redisGet.mockResolvedValue(null);
      redisSet.mockRejectedValue(new Error("marker unavailable"));

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
      config.NUQ_BACKEND = "pg";
      expect((await scrapeQueue.getJob(jobId))?.id).toBe(jobId);
      const wait = waitForQueuedJob(jobs[0], 15_000, false);
      const taken = await scrapeQueueFdb.getJobToProcess();
      expect(taken?.id).toBe(jobId);
      await scrapeQueueFdb.jobFinish(jobId, taken!.lock!, { ok: true });
      await expect(wait).resolves.toEqual({ ok: true });
      await scrapeQueue.removeJob(jobId);

      const cancelId = randomUUID();
      const cancelTeamId = randomUUID();
      config.NUQ_BACKEND = "fdb";
      await fdbEnqueueScrapeJobs(
        [
          {
            jobId: cancelId,
            data: {
              mode: "single_urls",
              url: "https://example.com/cancel",
              team_id: cancelTeamId,
            } as any,
            priority: 0,
            backlogTimeoutMs: 60_000,
          },
        ],
        cancelTeamId,
      );
      // ID-only standalone cancellation also probes durable FDB state.
      config.NUQ_BACKEND = "pg";
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
    await scrapeQueueFdb.removeJob(jobId);
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

    // The emitted ungated crawl_finished job is visible to legacy authority
    // recovery even though it does not touch team gate counters.
    await expect(
      crawlFinishedQueueFdb.hasReadyOrActiveJobForOwner(teamId),
    ).resolves.toBe(true);

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
    await expect(
      crawlFinishedQueueFdb.hasReadyOrActiveJobForOwner(teamId),
    ).resolves.toBe(false);

    // cancel on an already-completed group is a no-op
    expect(await crawlGroup.cancelGroup(gid)).toBe(false);
  });

  test("external slot mirror consumes and releases FDB capacity", async () => {
    const teamId = randomUUID();
    const holder = randomUUID();
    await mirrorExternalSlotAcquire(teamId, holder, 30_000);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
    await expect(
      reserveExternalSlot(teamId, randomUUID(), 30_000, 1),
    ).resolves.toBe(false);
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
  });

  test("concurrent FDB external reservations cannot oversubscribe a team", async () => {
    const teamId = randomUUID();
    const holders = Array.from({ length: 32 }, () => randomUUID());
    const results = await Promise.all(
      holders.map(holder => reserveExternalSlot(teamId, holder, 30_000, 3)),
    );
    const admitted = holders.filter((_, index) => results[index]);

    expect(admitted).toHaveLength(3);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(3);

    await Promise.all(
      admitted.map(holder => mirrorExternalSlotRelease(teamId, holder)),
    );
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
  });

  test("existing FDB holder renewal does not overwrite a newer team limit", async () => {
    const teamId = randomUUID();
    const firstHolder = randomUUID();
    const secondHolder = randomUUID();
    await expect(
      reserveExternalSlot(teamId, firstHolder, 30_000, 10),
    ).resolves.toBe(true);
    await expect(
      reserveExternalSlot(teamId, secondHolder, 30_000, 2),
    ).resolves.toBe(true);

    const readStoredLimit = async () =>
      await getNuqFdbDatabase().doTn(async tn =>
        decodeI64(await tn.snapshot().get(scrapeQueueFdb.ks.teamLimit(teamId))),
      );
    await expect(readStoredLimit()).resolves.toBe(2);
    await expect(renewExternalSlot(teamId, firstHolder, 30_000)).resolves.toBe(
      true,
    );
    await expect(readStoredLimit()).resolves.toBe(2);

    await Promise.all([
      mirrorExternalSlotRelease(teamId, firstHolder),
      mirrorExternalSlotRelease(teamId, secondHolder),
    ]);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
  });

  test("FDB external reservation includes queue occupancy atomically", async () => {
    const teamId = randomUUID();
    const jobIds = [randomUUID(), randomUUID()];
    await scrapeQueueFdb.addJobs(
      jobIds.map(jobId => ({
        id: jobId,
        data: {
          mode: "single_urls",
          url: "https://example.com/capacity",
          team_id: teamId,
        } as any,
        options: { ownerId: teamId },
      })),
      { teamLimit: 2, queueCap: 10 },
    );
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(2);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        reserveExternalSlot(teamId, randomUUID(), 30_000, 2),
      ),
    );
    expect(results).toEqual(Array(8).fill(false));
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(2);

    await Promise.all(jobIds.map(jobId => scrapeQueueFdb.removeJob(jobId)));
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
  });

  test("denied external reservation lowers the FDB promotion gate", async () => {
    const teamId = randomUUID();
    const jobIds = [randomUUID(), randomUUID(), randomUUID()];
    const jobs = await scrapeQueueFdb.addJobs(
      jobIds.map(jobId => ({
        id: jobId,
        data: {
          mode: "single_urls",
          url: "https://example.com/lowered-capacity",
          team_id: teamId,
        } as any,
        options: { ownerId: teamId },
      })),
      { teamLimit: 2, queueCap: 10 },
    );
    const active = jobs.filter(job => job.status !== "backlog");
    expect(active).toHaveLength(2);
    expect(await scrapeQueueFdb.getTeamPendingCount(teamId)).toBe(1);

    await expect(
      reserveExternalSlot(teamId, randomUUID(), 30_000, 1),
    ).resolves.toBe(false);
    await scrapeQueueFdb.removeJob(active[0].id);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
    expect(await scrapeQueueFdb.getTeamPendingCount(teamId)).toBe(1);

    await Promise.all(
      jobIds
        .filter(jobId => jobId !== active[0].id)
        .map(jobId => scrapeQueueFdb.removeJob(jobId)),
    );
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
    expect(await scrapeQueueFdb.getTeamPendingCount(teamId)).toBe(0);
  });
});
