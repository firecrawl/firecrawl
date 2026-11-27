import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { vi } from "vitest";
import { config } from "../../config";
import type { ScrapeOptions } from "../../controllers/v2/types";
import { redisEvictConnection } from "../../services/redis";
import { requestContext } from "../../lib/request-context";
import { noLimits } from "../../service/defaults";
import { testService, withService } from "../../service/testing";
import type { ScrapeJobData } from "../../types";
import {
  fdbQueueEnabled,
  isFdbTeam,
  resolveJobBackend,
  resolveNewGroupBackend,
  fdbEnqueueScrapeJobs,
  scrapeQueue,
  crawlGroup,
  crawlFinishedQueue,
  reserveExternalSlot,
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

const defaultScrapeOptions: ScrapeOptions = {
  formats: [{ type: "markdown" }],
  onlyMainContent: true,
  onlyCleanContent: false,
  waitFor: 0,
  mobile: false,
  skipTlsVerification: false,
  removeBase64Images: true,
  fastMode: false,
  blockAds: true,
  proxy: "auto",
  checkPromptInjection: false,
};

function makeScrapeJobData(
  overrides: Partial<Extract<ScrapeJobData, { mode: "single_urls" }>> & {
    team_id: string;
  },
): ScrapeJobData {
  return {
    mode: "single_urls",
    url: "https://example.com",
    scrapeOptions: defaultScrapeOptions,
    origin: "test",
    apiKeyId: null,
    zeroDataRetention: false,
    ...overrides,
  };
}

describeIf("NuQ router (forced FDB mode)", () => {
  beforeAll(() => {
    config.NUQ_BACKEND = "fdb";
  });

  afterAll(async () => {
    config.NUQ_BACKEND = prevNuqBackend;
    // forced mode writes into the real "scrape"/"crawl_finished" queue
    // namespaces; wipe them so reruns and other suites start clean
    const fdb = getFdb();
    const db = getNuqFdbDatabase();
    for (const name of ["scrape", "crawl_finished"]) {
      const r = fdb.tuple.range(["nuq", name]);
      await db.doTn(async tn => tn.clearRange(r.begin, r.end));
    }
  });

  test("routing decisions resolve to fdb when forced", async () => {
    expect(fdbQueueEnabled()).toBe(true);
    expect(await isFdbTeam(randomUUID())).toBe(true);
    expect(await resolveNewGroupBackend(randomUUID())).toBe("fdb");
    expect(
      await resolveJobBackend(
        makeScrapeJobData({
          team_id: randomUUID(),
        }),
      ),
    ).toBe("fdb");
  });

  test("enqueue -> routed take -> routed finish -> routed waitForJob, all on FDB", async () => {
    const teamId = randomUUID();
    const jobId = randomUUID();
    const { jobs, backloggedCount } = await fdbEnqueueScrapeJobs(
      [
        {
          jobId,
          data: makeScrapeJobData({
            team_id: teamId,
          }),
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
    expect(taken.backend).toBe("fdb");

    expect(await scrapeQueue.renewLock(jobId, taken.lock)).toBe(true);
    expect(await scrapeQueue.jobFinish(jobId, taken.lock, { ok: true })).toBe(
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
      redisSet.mockResolvedValue("OK");

      const { jobs, backloggedCount } = await fdbEnqueueScrapeJobs(
        [
          {
            jobId,
            data: makeScrapeJobData({
              team_id: teamId,
            }),
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

      await new Promise<void>(resolve => {
        setTimeout(resolve, 800);
      });

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
          data: makeScrapeJobData({
            team_id: teamId,
            crawl_id: gid,
          }),
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
      } catch {
        // PG fallback poll can throw without a database; FDB must still win
      }
    }
    expect(taken?.id).toBe(jobId);
    await scrapeQueue.jobFinish(jobId, taken.lock, null);

    expect((await crawlGroup.getGroup(gid))?.status).toBe("completed");
    expect(await scrapeQueue.getGroupNumericStats(gid)).toMatchObject({
      completed: 1,
    });
    const listing = await scrapeQueue.getGroupJobs(gid, "completed", 10, 0);
    expect(listing.map(j => j.id)).toEqual([jobId]);

    // the emitted crawl_finished job is consumable through the router
    let fin: any = null;
    for (let i = 0; i < 10 && !fin; i++) {
      try {
        fin = await crawlFinishedQueue.getJobToProcess();
      } catch {
        // PG fallback poll can throw without a database; FDB must still win
      }
    }
    expect(fin).not.toBeNull();
    expect(fin.groupId).toBe(gid);
    expect(await crawlFinishedQueue.jobFinish(fin.id, fin.lock, null)).toBe(
      true,
    );

    // cancel on an already-completed group is a no-op
    expect(await crawlGroup.cancelGroup(gid)).toBe(false);
  });

  test("routed group listing returns failed job data and reason", async () => {
    const teamId = randomUUID();
    const gid = randomUUID();
    const jobId = randomUUID();
    await crawlGroup.addGroup(gid, teamId, 60_000, { backend: "fdb" });
    await fdbEnqueueScrapeJobs(
      [
        {
          jobId,
          data: makeScrapeJobData({
            url: "https://example.com/failed",
            team_id: teamId,
            crawl_id: gid,
          }),
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
      } catch {
        // PG fallback poll can throw without a database; FDB must still win
      }
    }
    expect(taken?.id).toBe(jobId);
    await scrapeQueue.jobFail(jobId, taken.lock, "routed failure");

    const failed = await scrapeQueue.getGroupJobs(gid, "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      id: jobId,
      failedReason: "routed failure",
      data: { url: "https://example.com/failed" },
    });
    expect(await scrapeQueue.getGroupJobs(gid, "completed")).toEqual([]);
  });

  test("routed group listing probes FDB when crawl state is missing", async () => {
    const forcedBackend = config.NUQ_BACKEND;
    const redisGet = vi
      .spyOn(redisEvictConnection, "get")
      .mockResolvedValue(null);
    config.NUQ_BACKEND = "pg";
    try {
      const teamId = randomUUID();
      const gid = randomUUID();
      const jobId = randomUUID();
      await crawlGroup.addGroup(gid, teamId, 60_000, { backend: "fdb" });
      await fdbEnqueueScrapeJobs(
        [
          {
            jobId,
            data: makeScrapeJobData({
              url: "https://example.com/probed",
              team_id: teamId,
              crawl_id: gid,
            }),
            priority: 0,
            backlogTimeoutMs: 60_000,
          },
        ],
        teamId,
      );

      const taken = await scrapeQueueFdb.getJobToProcess();
      expect(taken?.id).toBe(jobId);
      await scrapeQueueFdb.jobFail(jobId, taken!.lock!, "probed failure");

      const failed = await scrapeQueue.getGroupJobs(gid, "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        id: jobId,
        failedReason: "probed failure",
      });
    } finally {
      config.NUQ_BACKEND = forcedBackend;
      redisGet.mockRestore();
    }
  });

  test("external slot mirror consumes and releases FDB capacity", async () => {
    const teamId = randomUUID();
    const holder = randomUUID();
    await reserveExternalSlot(teamId, holder, 30_000, 10);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
    // re-acquire (heartbeat) must not double-count
    await reserveExternalSlot(teamId, holder, 30_000, 10);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
    await mirrorExternalSlotRelease(teamId, holder);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
    // double release is a no-op
    await mirrorExternalSlotRelease(teamId, holder);
    expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
  });

  test("external slot release follows recorded FDB backend when settlement omits context", async () => {
    const forcedBackend = config.NUQ_BACKEND;
    const markers = new Map<string, string>();
    const fakeRedis = new IORedis({
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    vi.spyOn(fakeRedis, "zcount").mockResolvedValue(0);
    vi.spyOn(fakeRedis, "set").mockImplementation(async (...args) => {
      const [key, value] = args;
      markers.set(String(key), String(value));
      return "OK";
    });
    vi.spyOn(fakeRedis, "get").mockImplementation(
      async key => markers.get(String(key)) ?? null,
    );
    vi.spyOn(fakeRedis, "del").mockImplementation(async (...keys) => {
      let removed = 0;
      for (const key of keys) {
        if (markers.delete(String(key))) {
          removed++;
        }
      }
      return removed;
    });
    vi.spyOn(fakeRedis, "zrem").mockResolvedValue(0);
    const queueService = await import("../../services/queue-service.js");
    const redisSpy = vi
      .spyOn(queueService, "getRedisConnection")
      .mockReturnValue(fakeRedis);
    config.NUQ_BACKEND = "pg";
    try {
      const limits = {
        ...noLimits(),
        queueBackend: (ctx: { apiKeyId?: number | null }) =>
          ctx.apiKeyId === 999 ? ("fdb" as const) : undefined,
      };
      await withService(
        testService(
          {},
          { core: { name: "core" }, logger: { error: () => {} } },
          { limits },
        ),
        async () => {
          const teamId = randomUUID();
          const holder = randomUUID();
          const ctx = requestContext({
            teamId,
            zeroDataRetention: false,
            apiKeyId: 999,
          });
          expect(
            await reserveExternalSlot(teamId, holder, 30_000, 10, ctx),
          ).toBe(true);
          expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(1);
          expect(markers.size).toBe(1);

          // Settlement runs without the original request context; the recorded
          // backend marker still routes the release to FDB.
          await mirrorExternalSlotRelease(teamId, holder);
          expect(await scrapeQueueFdb.getTeamActiveCount(teamId)).toBe(0);
          expect(markers.size).toBe(0);
        },
      );
    } finally {
      config.NUQ_BACKEND = forcedBackend;
      redisSpy.mockRestore();
      fakeRedis.disconnect();
    }
  });
});
