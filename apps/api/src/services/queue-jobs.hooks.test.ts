import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrapeJobData } from "../types";

const mocks = vi.hoisted(() => {
  const pipeline = {
    set: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    sadd: vi.fn().mockReturnThis(),
    zrem: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    exec: vi.fn(async () => []),
  };

  const redis = {
    zremrangebyscore: vi.fn(async () => 0),
    zrangebyscore: vi.fn(async (): Promise<string[]> => []),
    zrange: vi.fn(async (): Promise<string[]> => []),
    zcount: vi.fn(async () => 0),
    zadd: vi.fn(async () => 1),
    zrem: vi.fn(async () => 1),
    zpopmin: vi.fn(async (): Promise<string[]> => []),
    zscan: vi.fn(async (): Promise<[string, string[]]> => ["0", []]),
    get: vi.fn(async (): Promise<string | null> => null),
    del: vi.fn(async () => 1),
    pipeline: vi.fn(() => pipeline),
  };

  return {
    pipeline,
    redis,
    unlimitedConcurrency: vi.fn(() => false),
    resolveJobBackend: vi.fn(async (): Promise<"pg" | "fdb"> => "pg"),
    fdbEnqueueScrapeJobs: vi.fn(),
    addJob: vi.fn(async (id: string, data: any) => ({ id, data })),
    addJobs: vi.fn(async (jobs: any[]) =>
      jobs.map(job => ({ id: job.id, data: job.data })),
    ),
    promoteJobFromBacklogOrAdd: vi.fn(async (id: string, data: any) => ({
      id,
      data,
    })),
    getBackloggedJobIDsOfOwner: vi.fn(async (): Promise<string[]> => []),
    getJobsFromBacklog: vi.fn(async (): Promise<any[]> => []),
    getJobs: vi.fn(async (): Promise<any[]> => []),
    getACUCTeam: vi.fn(async () => ({ concurrency_limit: 2 })),
    getCrawl: vi.fn(async (): Promise<any> => null),
    abTestJob: vi.fn(),
    shouldSendConcurrencyLimitNotification: vi.fn(async () => false),
    sendNotificationWithCustomDays: vi.fn(async () => undefined),
    nuqFdbHealthCheck: vi.fn(async () => false),
    getTeamPendingCount: vi.fn(async () => 0),
  };
});

vi.mock("./queue-service", () => ({
  getRedisConnection: () => mocks.redis,
}));

vi.mock("../lib/concurrency-redis", () => ({
  getTeamQueueLimit: (limit: number) => Math.max(limit * 10, 100),
  MAX_BACKLOG_TIMEOUT_MS: 86_400_000,
  constructConcurrencyLimitKey: (teamId: string) =>
    "concurrency-limiter:" + teamId,
  pushConcurrencyLimitActiveJob: vi.fn(async () => undefined),
  removeConcurrencyLimitActiveJob: vi.fn(async () => undefined),
  getConcurrencyLimitActiveJobsCount: vi.fn(async () => 0),
}));

vi.mock("../lib/crawl-redis", () => ({
  getCrawl: mocks.getCrawl,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("./worker/nuq", () => ({
  scrapeQueue: {
    addJob: mocks.addJob,
    addJobs: mocks.addJobs,
    promoteJobFromBacklogOrAdd: mocks.promoteJobFromBacklogOrAdd,
    getBackloggedJobIDsOfOwner: mocks.getBackloggedJobIDsOfOwner,
    getJobsFromBacklog: mocks.getJobsFromBacklog,
    getJobs: mocks.getJobs,
  },
}));

vi.mock("./worker/nuq-router", () => ({
  fdbEnqueueScrapeJobs: mocks.fdbEnqueueScrapeJobs,
  resolveJobBackend: mocks.resolveJobBackend,
  scrapeQueue: {
    waitForJob: vi.fn(),
  },
}));

vi.mock("./worker/nuq-fdb", () => ({
  nuqFdbHealthCheck: mocks.nuqFdbHealthCheck,
  scrapeQueueFdb: {
    getTeamPendingCount: mocks.getTeamPendingCount,
  },
  withFdbTimeout: <T>(promise: Promise<T>) => promise,
}));

vi.mock("../lib/otel-tracer", () => ({
  serializeTraceContext: vi.fn(() => undefined),
}));

vi.mock("../lib/redis-pipeline", () => ({
  reportPipelineError: vi.fn(),
}));

import { concurrentJobDone } from "../lib/concurrency-limit";
import { reconcileConcurrencyQueue } from "../lib/concurrency-queue-reconciler";
import { requestContext } from "../lib/request-context";
import type { HookHandlers } from "../service/hooks";
import { noLimits } from "../service/defaults";
import { createService, replaceService } from "../service/service";
import { addScrapeJob, addScrapeJobs } from "./queue-jobs";

function installHooks(hooks?: HookHandlers, report = vi.fn()) {
  replaceService(
    createService(
      {
        modules: {
          limits: {
            ...noLimits(),
            concurrency: async () =>
              mocks.unlimitedConcurrency()
                ? null
                : ((await mocks.getACUCTeam())?.concurrency_limit ?? 2),
            teamConcurrency: async () =>
              mocks.unlimitedConcurrency()
                ? null
                : ((await mocks.getACUCTeam())?.concurrency_limit ?? 2),
          },
        },
        extensions: hooks ? [{ name: "test-hooks", hooks }] : [],
      },
      {
        core: { name: "core" },
        logger: { error: report },
      },
    ),
  );
  return report;
}

function makeScrapeJob(
  overrides: Partial<Extract<ScrapeJobData, { mode: "single_urls" }>> = {},
): ScrapeJobData {
  return {
    mode: "single_urls",
    url: "https://example.com",
    team_id: "team-1",
    zeroDataRetention: false,
    origin: "api",
    apiKeyId: 12,
    scrapeOptions: {} as any,
    ctx: requestContext({
      teamId: "team-1",
      zeroDataRetention: false,
      apiKeyId: 12,
    }),
    ...overrides,
  };
}

describe("queue and concurrency hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replaceService(undefined);
    mocks.unlimitedConcurrency.mockReturnValue(false);
    mocks.resolveJobBackend.mockResolvedValue("pg");
    mocks.redis.zrangebyscore.mockResolvedValue([]);
    mocks.redis.zcount.mockResolvedValue(0);
    mocks.redis.zpopmin.mockResolvedValue([]);
    mocks.redis.zscan.mockResolvedValue(["0", []]);
    mocks.redis.get.mockResolvedValue(null);
    mocks.getACUCTeam.mockResolvedValue({ concurrency_limit: 2 });
    mocks.getCrawl.mockResolvedValue(null);
    mocks.getBackloggedJobIDsOfOwner.mockResolvedValue([]);
    mocks.getJobsFromBacklog.mockResolvedValue([]);
    mocks.getJobs.mockResolvedValue([]);
  });

  afterEach(() => {
    replaceService(undefined);
  });

  it("leaves addScrapeJob unchanged when no service is installed or no handler is registered", async () => {
    const job = makeScrapeJob();
    const withoutService = await addScrapeJob(job, "job-no-service");
    expect(withoutService).toEqual({
      id: "job-no-service",
      data: expect.objectContaining({ url: "https://example.com" }),
    });

    installHooks();
    const withoutHandlers = await addScrapeJob(job, "job-no-handlers");
    expect(withoutHandlers).toEqual({
      id: "job-no-handlers",
      data: expect.objectContaining({ url: "https://example.com" }),
    });
  });

  it("emits job.enqueued with accurate kind and ctx across PG single and batch enqueues", async () => {
    const events: Array<{ jobId: string; kind: string; teamId: string }> = [];
    installHooks({
      "job.enqueued": event => {
        events.push({
          jobId: event.jobId,
          kind: event.kind,
          teamId: event.ctx.teamId,
        });
      },
    });

    await addScrapeJob(makeScrapeJob(), "job-scrape");
    await addScrapeJob(
      makeScrapeJob({ crawl_id: undefined, crawlerOptions: {} }),
      "job-scrape-with-crawler-options",
    );
    await addScrapeJobs([
      {
        jobId: "job-crawl",
        priority: 10,
        data: makeScrapeJob({ crawl_id: "crawl-1", crawlerOptions: {} }),
      },
      {
        jobId: "job-batch",
        priority: 10,
        data: makeScrapeJob({ crawl_id: "batch-1", crawlerOptions: undefined }),
      },
    ]);

    expect(events).toEqual([
      { jobId: "job-scrape", kind: "scrape", teamId: "team-1" },
      {
        jobId: "job-scrape-with-crawler-options",
        kind: "scrape",
        teamId: "team-1",
      },
      { jobId: "job-crawl", kind: "crawl", teamId: "team-1" },
      { jobId: "job-batch", kind: "batchScrape", teamId: "team-1" },
    ]);
  });

  it("emits concurrency.limited on PG backlog and job.enqueued upon promotion", async () => {
    const events: string[] = [];
    installHooks({
      "concurrency.limited": event => {
        events.push(`limited:${event.ctx.teamId}:${event.limit}`);
      },
      "job.enqueued": event => {
        events.push(`enqueued:${event.jobId}:${event.kind}`);
      },
    });

    // Team already at concurrency limit of 2
    mocks.redis.zrangebyscore.mockResolvedValue(["active-1", "active-2"]);
    const queuedJob = makeScrapeJob();
    const res = await addScrapeJob(queuedJob, "job-backlogged");
    expect(res).toBeNull();
    expect(events).toEqual(["limited:team-1:2"]);

    // One slot frees up and concurrentJobDone promotes the backlogged job
    mocks.redis.zrangebyscore.mockResolvedValue(["active-1"]);
    mocks.redis.zpopmin.mockResolvedValueOnce([
      "job-backlogged",
      String(Date.now() + 60_000),
    ]);
    mocks.redis.get.mockResolvedValueOnce(
      JSON.stringify({
        id: "job-backlogged",
        data: queuedJob,
        priority: 0,
        listenable: false,
      }),
    );

    await concurrentJobDone({
      id: "active-2",
      data: queuedJob,
    } as any);

    expect(events).toEqual([
      "limited:team-1:2",
      "enqueued:job-backlogged:scrape",
    ]);
  });

  it("emits concurrency.limited for PG batch overflow and both hooks for FDB backlogged enqueues", async () => {
    const events: string[] = [];
    const report = installHooks({
      "job.enqueued": event => {
        events.push(`enqueued:${event.jobId}:${event.kind}`);
      },
      "concurrency.limited": event => {
        events.push(`limited:${event.ctx.teamId}:${event.limit}`);
        throw new Error("observer failure must be isolated");
      },
    });

    // PG batch: 1 slot free out of 2, enqueue 2 jobs -> 1 direct, 1 limited
    mocks.redis.zrangebyscore.mockResolvedValue(["active-1"]);
    await addScrapeJobs([
      { jobId: "pg-1", priority: 0, data: makeScrapeJob() },
      { jobId: "pg-2", priority: 0, data: makeScrapeJob() },
    ]);

    expect(events).toEqual(["limited:team-1:2", "enqueued:pg-1:scrape"]);
    expect(report).toHaveBeenCalledTimes(1);

    events.length = 0;
    mocks.resolveJobBackend.mockResolvedValue("fdb");
    mocks.fdbEnqueueScrapeJobs.mockResolvedValue({
      jobs: [
        {
          id: "fdb-1",
          status: "backlog",
          data: makeScrapeJob(),
          backlogLimit: 1,
        },
      ],
      backloggedCount: 1,
      teamLimit: 4,
      backlogLimit: 1,
    });

    const fdbRes = await addScrapeJob(makeScrapeJob(), "fdb-1");
    expect(fdbRes).toBeNull();
    expect(events).toEqual(["enqueued:fdb-1:scrape", "limited:team-1:1"]);

    events.length = 0;
    mocks.fdbEnqueueScrapeJobs.mockResolvedValue({
      jobs: [
        {
          id: "fdb-b1",
          status: "backlog",
          data: makeScrapeJob({ crawl_id: "batch-2" }),
          backlogLimit: 6,
        },
      ],
      backloggedCount: 1,
      teamLimit: 6,
      backlogLimit: 6,
    });
    await addScrapeJobs([
      {
        jobId: "fdb-b1",
        priority: 0,
        data: makeScrapeJob({ crawl_id: "batch-2" }),
      },
    ]);
    expect(events).toEqual(["enqueued:fdb-b1:batchScrape", "limited:team-1:6"]);
  });

  it("emits concurrency.limited for PG crawl-limit backlogs and job.enqueued for reconciler promotions", async () => {
    const events: string[] = [];
    installHooks({
      "concurrency.limited": event => {
        events.push(`limited:${event.ctx.teamId}:${event.limit}`);
      },
      "job.enqueued": event => {
        events.push(`enqueued:${event.jobId}:${event.kind}`);
      },
    });

    // PG single crawl-limited path ("yes-crawl")
    mocks.getCrawl.mockResolvedValue({ maxConcurrency: 1 });
    mocks.redis.zrangebyscore.mockResolvedValueOnce(["crawl-active-1"]);
    const crawlJob = makeScrapeJob({
      crawl_id: "crawl-cap",
      crawlerOptions: {},
    });
    const singleRes = await addScrapeJob(crawlJob, "crawl-limited-1");
    expect(singleRes).toBeNull();
    expect(events).toEqual(["limited:team-1:1"]);

    // PG batch crawl-limited path (jobsForcedToCQ)
    events.length = 0;
    mocks.redis.zrangebyscore
      .mockResolvedValueOnce(["crawl-active-1"])
      .mockResolvedValueOnce([]);
    await addScrapeJobs([
      { jobId: "crawl-limited-2", priority: 0, data: crawlJob },
    ]);
    expect(events).toEqual(["limited:team-1:1"]);

    // Reconciler promotions (both drift recovery and queue drain)
    events.length = 0;
    mocks.redis.zrangebyscore.mockResolvedValue([]);
    mocks.getBackloggedJobIDsOfOwner.mockResolvedValueOnce(["drift-job"]);
    mocks.getJobsFromBacklog.mockResolvedValueOnce([
      { id: "drift-job", data: makeScrapeJob(), priority: 0 },
    ]);
    mocks.redis.zpopmin.mockResolvedValueOnce([
      "drain-job",
      String(Date.now() + 60_000),
    ]);
    mocks.redis.get.mockResolvedValueOnce(
      JSON.stringify({
        id: "drain-job",
        data: makeScrapeJob({ crawl_id: "batch-drain" }),
        priority: 0,
        listenable: false,
      }),
    );

    await reconcileConcurrencyQueue({ teamId: "team-1" });
    expect(events).toEqual([
      "enqueued:drift-job:scrape",
      "enqueued:drain-job:batchScrape",
    ]);
  });
});
