import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCrawl: vi.fn(),
  redis: {
    zpopmin: vi.fn(),
    get: vi.fn(),
    del: vi.fn(async () => 1),
    zadd: vi.fn(async () => 1),
    zrangebyscore: vi.fn(),
  },
}));

vi.mock("../services/queue-service", () => ({
  getRedisConnection: () => mocks.redis,
}));
vi.mock("./crawl-redis", () => ({ getCrawl: mocks.getCrawl }));
vi.mock("../services/worker/nuq", () => ({ scrapeQueue: {} }));
vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { getNextConcurrentJob } from "./concurrency-limit";

const queued = (id: string) => ({
  id,
  data: {
    mode: "single_urls",
    url: "https://example.com",
    crawl_id: "crawl-1",
    team_id: "team-1",
    zeroDataRetention: false,
    origin: "api",
    apiKeyId: null,
    scrapeOptions: {},
  },
  priority: 0,
  listenable: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  const score = String(Date.now() + 60_000);
  mocks.redis.zpopmin
    .mockResolvedValueOnce(["job-2", score])
    .mockResolvedValueOnce([]);
  mocks.redis.get.mockResolvedValue(JSON.stringify(queued("job-2")));
  mocks.getCrawl.mockResolvedValue(null);
});

test("holds a job of a crawl with a missing stored crawl while one of its jobs runs", async () => {
  mocks.redis.zrangebyscore.mockResolvedValue(["job-1"]);

  await expect(getNextConcurrentJob("team-1")).resolves.toBeNull();
  expect(mocks.redis.zadd).toHaveBeenCalledWith(
    "concurrency-limit-queue:team-1",
    expect.any(Number),
    "job-2",
  );
});

test("admits one job of a crawl with a missing stored crawl when none runs", async () => {
  mocks.redis.zrangebyscore.mockResolvedValue([]);

  const next = await getNextConcurrentJob("team-1");
  expect(next?.job.id).toBe("job-2");
});
