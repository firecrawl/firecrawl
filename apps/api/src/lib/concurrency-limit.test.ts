const mockRedis = {
  del: jest.fn(),
  get: jest.fn(),
  sadd: jest.fn(),
  set: jest.fn(),
  zadd: jest.fn(),
  zcount: jest.fn(),
  zpopmin: jest.fn(),
  zrange: jest.fn(),
  zrangebyscore: jest.fn(),
  zrem: jest.fn(),
  zremrangebyscore: jest.fn(),
};

const mockGetACUCTeam = jest.fn();
const mockGetCrawl = jest.fn();
const mockAbTestJob = jest.fn();
const mockPromoteJobFromBacklogOrAdd = jest.fn();
const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

jest.mock("../services/queue-service", () => ({
  getRedisConnection: () => mockRedis,
}));

jest.mock("../controllers/auth", () => ({
  getACUCTeam: (...args: any[]) => mockGetACUCTeam(...args),
}));

jest.mock("./crawl-redis", () => ({
  getCrawl: (...args: any[]) => mockGetCrawl(...args),
}));

jest.mock("../services/ab-test", () => ({
  abTestJob: (...args: any[]) => mockAbTestJob(...args),
}));

jest.mock("../services/worker/nuq", () => ({
  scrapeQueue: {
    promoteJobFromBacklogOrAdd: (...args: any[]) =>
      mockPromoteJobFromBacklogOrAdd(...args),
  },
}));

jest.mock("./logger", () => ({
  logger: mockLogger,
}));

import { concurrentJobDone } from "./concurrency-limit";

async function flushAsyncDrain() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function makeJob(id: string, data: Record<string, any> = {}) {
  return {
    id,
    data: {
      mode: "single_urls",
      team_id: "team-1",
      ...data,
    },
    priority: 10,
  } as any;
}

describe("concurrentJobDone", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockRedis.del.mockResolvedValue(1);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.sadd.mockResolvedValue(1);
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.zadd.mockResolvedValue(1);
    mockRedis.zcount.mockResolvedValue(0);
    mockRedis.zpopmin.mockResolvedValue([]);
    mockRedis.zrange.mockResolvedValue([]);
    mockRedis.zrangebyscore.mockResolvedValue([]);
    mockRedis.zrem.mockResolvedValue(1);
    mockRedis.zremrangebyscore.mockResolvedValue(0);

    mockGetACUCTeam.mockResolvedValue({ concurrency: 2 });
    mockGetCrawl.mockResolvedValue(null);
    mockPromoteJobFromBacklogOrAdd.mockResolvedValue({ id: "next-job" });
  });

  it("does not wait for queued job promotion before returning", async () => {
    const nextJob = makeJob("next-job");
    mockRedis.zpopmin.mockResolvedValueOnce([
      nextJob.id,
      String(Date.now() + 60_000),
    ]);
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(nextJob));

    await concurrentJobDone(makeJob("finished-job"));

    expect(mockRedis.zrem).toHaveBeenCalledWith(
      "concurrency-limiter:team-1",
      "finished-job",
    );
    expect(mockPromoteJobFromBacklogOrAdd).not.toHaveBeenCalled();

    await flushAsyncDrain();

    expect(mockPromoteJobFromBacklogOrAdd).toHaveBeenCalledWith(
      "next-job",
      nextJob.data,
      {
        priority: nextJob.priority,
        listenable: undefined,
        ownerId: "team-1",
        groupId: undefined,
      },
    );
  });

  it("does not fail job completion when concurrency cleanup fails", async () => {
    const error = new Error("redis unavailable");
    mockRedis.zrem.mockRejectedValueOnce(error);

    await expect(concurrentJobDone(makeJob("finished-job"))).resolves.toBe(
      undefined,
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Failed to clean up completed concurrency job",
      expect.objectContaining({
        error,
        jobId: "finished-job",
        teamId: "team-1",
      }),
    );

    await flushAsyncDrain();
  });
});
