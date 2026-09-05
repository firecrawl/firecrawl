import { randomUUID } from "crypto";

// Keep infrastructure unrelated to these Redis operations out of the test.
// Commands and pipeline replies use the real harness Redis/Dragonfly server.
vi.mock("../../services/redis", async () => {
  const { Redis } = await import("ioredis");
  return {
    redisEvictConnection: new Redis(
      process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      {
        maxRetriesPerRequest: 1,
      },
    ),
  };
});
vi.mock("../../services/queue-service", async () => {
  const { redisEvictConnection } = await import("../../services/redis.js");
  return { getRedisConnection: () => redisEvictConnection };
});
vi.mock("../../scraper/WebScraper/crawler", () => ({ WebCrawler: class {} }));
vi.mock("../../lib/otel-tracer", () => ({
  withSpan: (_name: string, fn: (span: object) => unknown) => fn({}),
  setSpanAttributes: () => {},
}));
vi.mock("../../lib/zdr-helpers", () => ({}));
vi.mock("../../lib/logger", () => {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    child: () => logger,
  };
  return { logger };
});
vi.mock("../../lib/concurrency-redis", () => ({
  MAX_BACKLOG_TIMEOUT_MS: 60000,
  constructConcurrencyLimitKey: (id: string) => `concurrency-limiter:${id}`,
}));
vi.mock("../../services/worker/nuq", () => ({}));
vi.mock("../../services/ab-test", () => ({}));
vi.mock("../../services/autumn/autumn.service", () => ({}));

import { redisEvictConnection as redis } from "../../services/redis";
import {
  addCrawlJobs,
  addCrawlJobDone,
  lockURL,
  lockURLs,
} from "../../lib/crawl-redis";
import { pushConcurrencyLimitedJobs } from "../../lib/concurrency-limit";

describe("Redis command failure propagation", () => {
  const id = randomUUID();
  const sc = {
    crawlerOptions: {},
    team_id: id,
    createdAt: 0,
    scrapeOptions: {},
    internalOptions: {},
  } as any;
  const jobs = Array.from({ length: 66000 }, (_, i) => `job-${id}-${i}`);
  const keys = [
    "jobs",
    "jobs_qualified",
    "jobs_done",
    "jobs_donez_ordered",
    "visited",
    "visited_unique",
  ].map(suffix => `crawl:${id}:${suffix}`);

  beforeEach(async () => {
    await redis.del(...keys, `concurrency-limit-queue:${id}`);
  });
  afterAll(async () => {
    await redis.del(...keys, `concurrency-limit-queue:${id}`);
    for (let i = 0; i < jobs.length; i += 1000) {
      await redis.del(...jobs.slice(i, i + 1000).map(job => `cq-job:${job}`));
    }
    await redis.srem(
      "concurrency-limit-queues",
      `concurrency-limit-queue:${id}`,
    );
    await redis.quit();
  });

  it("stores large batches and preserves URL deduplication", async () => {
    await addCrawlJobs(id, jobs);
    expect(await redis.scard(`crawl:${id}:jobs`)).toBe(jobs.length);
    const urls = jobs.map(job => `https://example.com/${job}`);
    expect(await lockURLs(id, sc, urls)).toBe(true);
    expect(await lockURLs(id, sc, urls)).toBe(false);
    expect(await lockURL(id, sc, "https://example.com/new")).toBe(true);
    expect(await lockURL(id, sc, "https://example.com/new")).toBe(false);
  });

  it("stores backlog batches larger than a single Dragonfly ZADD supports", async () => {
    const batch = jobs.slice(0, 33000).map(id => ({
      job: { id, data: {}, priority: 1, listenable: false },
      timeout: 60000,
    }));
    await pushConcurrencyLimitedJobs(id, batch);
    expect(await redis.zcard(`concurrency-limit-queue:${id}`)).toBe(
      batch.length,
    );
  });

  it("rejects a failed URL lock instead of admitting an unlocked URL", async () => {
    await redis.set(`crawl:${id}:visited`, "wrong-type");
    await expect(lockURL(id, sc, "https://example.com/")).rejects.toThrow(
      "WRONGTYPE",
    );
    expect(await redis.exists(`crawl:${id}:visited_unique`)).toBe(0);
  });

  it("rejects partial progress writes even when other commands succeeded", async () => {
    await redis.set(`crawl:${id}:jobs_done`, "wrong-type");
    await expect(addCrawlJobDone(id, jobs[0], true)).rejects.toThrow(
      "WRONGTYPE",
    );
    expect(await redis.zcard(`crawl:${id}:jobs_donez_ordered`)).toBe(1);
  });

  it("rejects a failed backlog index instead of reporting enqueue success", async () => {
    await redis.set(`concurrency-limit-queue:${id}`, "wrong-type");
    await expect(
      pushConcurrencyLimitedJobs(id, [
        {
          job: { id: jobs[0], data: {}, priority: 1, listenable: false },
          timeout: 60000,
        },
      ]),
    ).rejects.toThrow("WRONGTYPE");
  });
});
