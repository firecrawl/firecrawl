import { normalizeOwnerId } from "./owner-id";

const mocks = vi.hoisted(() => {
  const logger = {
    child: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  logger.child.mockReturnValue(logger);

  const jobs = [
    { id: "job-1", data: { team_id: "bypass", crawl_id: "crawl-1" } },
    { id: "job-2", data: { team_id: "bypass", crawl_id: "crawl-1" } },
    { id: "job-3", data: { team_id: "bypass", crawl_id: "crawl-1" } },
  ];

  return {
    jobs,
    logger,
    redis: {
      smembers: vi.fn(async () => ["concurrency-limit-queue:bypass"]),
      zscan: vi.fn(async () => ["0", []]),
    },
    getBackloggedOwnerIDs: vi.fn(),
    getBackloggedJobIDsOfOwner: vi.fn(),
    getBackloggedTeamIdOfOwner: vi.fn(),
    getJobsFromBacklog: vi.fn(),
    getJobs: vi.fn(),
    promoteJobFromBacklogOrAdd: vi.fn(),
    pushConcurrencyLimitActiveJob: vi.fn(),
    pushConcurrencyLimitedJob: vi.fn(),
    getConcurrencyLimitActiveJobs: vi.fn(),
    getNextConcurrentJob: vi.fn(),
    getCrawlConcurrencyLimitActiveJobs: vi.fn(),
    pushCrawlConcurrencyLimitActiveJob: vi.fn(),
    removeConcurrencyLimitActiveJob: vi.fn(),
    removeCrawlConcurrencyLimitActiveJob: vi.fn(),
    getCrawl: vi.fn(),
    getACUCTeam: vi.fn(),
  };
});

vi.mock("../services/queue-service", () => ({
  getRedisConnection: () => mocks.redis,
}));

vi.mock("../services/worker/nuq", () => ({
  scrapeQueue: {
    getBackloggedOwnerIDs: mocks.getBackloggedOwnerIDs,
    getBackloggedJobIDsOfOwner: mocks.getBackloggedJobIDsOfOwner,
    getBackloggedTeamIdOfOwner: mocks.getBackloggedTeamIdOfOwner,
    getJobsFromBacklog: mocks.getJobsFromBacklog,
    getJobs: mocks.getJobs,
    promoteJobFromBacklogOrAdd: mocks.promoteJobFromBacklogOrAdd,
  },
}));

vi.mock("./concurrency-limit", () => ({
  getConcurrencyLimitActiveJobs: mocks.getConcurrencyLimitActiveJobs,
  getNextConcurrentJob: mocks.getNextConcurrentJob,
  MAX_BACKLOG_TIMEOUT_MS: 172800000,
  pushConcurrencyLimitActiveJob: mocks.pushConcurrencyLimitActiveJob,
  pushConcurrencyLimitedJob: mocks.pushConcurrencyLimitedJob,
  pushCrawlConcurrencyLimitActiveJob: mocks.pushCrawlConcurrencyLimitActiveJob,
  getCrawlConcurrencyLimitActiveJobs: mocks.getCrawlConcurrencyLimitActiveJobs,
  removeConcurrencyLimitActiveJob: mocks.removeConcurrencyLimitActiveJob,
  removeCrawlConcurrencyLimitActiveJob:
    mocks.removeCrawlConcurrencyLimitActiveJob,
}));

vi.mock("./crawl-redis", () => ({ getCrawl: mocks.getCrawl }));
vi.mock("./logger", () => ({ logger: mocks.logger }));
vi.mock("../controllers/auth", () => ({ getACUCTeam: mocks.getACUCTeam }));
vi.mock("../services/autumn/autumn.service", () => ({
  DEFAULT_TEAM_LIMITS: { concurrency_limit: 100 },
}));

import { reconcileConcurrencyQueue } from "./concurrency-queue-reconciler";

describe("reconcileConcurrencyQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logger.child.mockReturnValue(mocks.logger);
    mocks.redis.smembers.mockResolvedValue([]);
    mocks.redis.zscan.mockResolvedValue(["0", []]);
    mocks.getBackloggedOwnerIDs.mockResolvedValue([normalizeOwnerId("bypass")]);
    mocks.getBackloggedJobIDsOfOwner.mockResolvedValue([
      "job-1",
      "job-2",
      "job-3",
    ]);
    mocks.getBackloggedTeamIdOfOwner.mockResolvedValue("bypass");
    mocks.getJobsFromBacklog.mockResolvedValue(mocks.jobs);
    mocks.getJobs.mockResolvedValue([]);
    mocks.promoteJobFromBacklogOrAdd.mockImplementation(async id => ({ id }));
    mocks.getConcurrencyLimitActiveJobs.mockResolvedValue([]);
    mocks.getNextConcurrentJob.mockResolvedValue(null);
    mocks.getCrawl.mockResolvedValue({
      maxConcurrency: 1,
      crawlerOptions: {},
    });
    mocks.getCrawlConcurrencyLimitActiveJobs.mockResolvedValue([]);
    mocks.getACUCTeam.mockResolvedValue({ concurrency_limit: 100 });
  });

  it("uses the raw team queue key and honors crawl maxConcurrency for recovered jobs", async () => {
    const result = await reconcileConcurrencyQueue();

    expect(mocks.redis.zscan).toHaveBeenCalledWith(
      "concurrency-limit-queue:bypass",
      "0",
      "COUNT",
      100,
    );
    expect(mocks.getConcurrencyLimitActiveJobs).toHaveBeenCalledWith("bypass");
    expect(mocks.promoteJobFromBacklogOrAdd).toHaveBeenCalledTimes(1);
    expect(mocks.pushConcurrencyLimitedJob).toHaveBeenCalledTimes(2);
    expect(mocks.pushConcurrencyLimitedJob).toHaveBeenCalledWith(
      "bypass",
      expect.objectContaining({ id: "job-2" }),
      expect.any(Number),
    );
    expect(result).toMatchObject({
      teamsScanned: 1,
      jobsStarted: 1,
      jobsRequeued: 2,
    });
  });

  it("counts existing team jobs under the raw ID before recovering backlog jobs", async () => {
    mocks.getBackloggedJobIDsOfOwner.mockResolvedValue(["job-1"]);
    mocks.getBackloggedTeamIdOfOwner.mockResolvedValue("bypass");
    mocks.getJobsFromBacklog.mockResolvedValue([
      { id: "job-1", data: { team_id: "bypass" } },
    ]);
    mocks.getACUCTeam.mockResolvedValue({ concurrency_limit: 1 });
    mocks.getConcurrencyLimitActiveJobs.mockImplementation(async teamId =>
      teamId === "bypass" ? ["active-job"] : [],
    );
    mocks.getJobs.mockImplementation(async ids =>
      ids.includes("active-job")
        ? [{ id: "active-job", data: { team_id: "bypass" } }]
        : [],
    );

    const result = await reconcileConcurrencyQueue();

    expect(mocks.getConcurrencyLimitActiveJobs).toHaveBeenNthCalledWith(
      1,
      "bypass",
    );
    expect(mocks.promoteJobFromBacklogOrAdd).not.toHaveBeenCalled();
    expect(mocks.pushConcurrencyLimitedJob).toHaveBeenCalledWith(
      "bypass",
      expect.objectContaining({ id: "job-1" }),
      expect.any(Number),
    );
    expect(result).toMatchObject({ jobsStarted: 0, jobsRequeued: 1 });
  });
});
