import { getACUCTeam } from "../controllers/auth";
import { getRedisConnection } from "../services/queue-service";
import { scrapeQueue } from "../services/worker/nuq";
import {
  getConcurrencyLimitActiveJobs,
  getNextConcurrentJob,
  pushConcurrencyLimitedJobs,
} from "./concurrency-limit";
import { reconcileConcurrencyQueue } from "./concurrency-queue-reconciler";
import { getCrawl } from "./crawl-redis";

jest.mock("../controllers/auth", () => ({
  getACUCTeam: jest.fn(),
}));

jest.mock("../services/queue-service", () => ({
  getRedisConnection: jest.fn(),
}));

jest.mock("../services/worker/nuq", () => ({
  scrapeQueue: {
    getBackloggedJobIDsOfOwner: jest.fn(),
    getJobsFromBacklog: jest.fn(),
    getJobs: jest.fn(),
    promoteJobFromBacklogOrAdd: jest.fn(),
  },
}));

jest.mock("./concurrency-limit", () => ({
  MAX_BACKLOG_TIMEOUT_MS: 172800000,
  getConcurrencyLimitActiveJobs: jest.fn(),
  getNextConcurrentJob: jest.fn(),
  pushConcurrencyLimitActiveJob: jest.fn(),
  pushConcurrencyLimitedJobs: jest.fn(),
  pushCrawlConcurrencyLimitActiveJob: jest.fn(),
  removeConcurrencyLimitActiveJob: jest.fn(),
  removeCrawlConcurrencyLimitActiveJob: jest.fn(),
}));

jest.mock("./crawl-redis", () => ({
  getCrawl: jest.fn(),
}));

const getACUCTeamMock = jest.mocked(getACUCTeam);
const getRedisConnectionMock = jest.mocked(getRedisConnection);
const getConcurrencyLimitActiveJobsMock = jest.mocked(getConcurrencyLimitActiveJobs);
const getNextConcurrentJobMock = jest.mocked(getNextConcurrentJob);
const pushConcurrencyLimitedJobsMock = jest.mocked(pushConcurrencyLimitedJobs);
const getCrawlMock = jest.mocked(getCrawl);
const scrapeQueueMock = jest.mocked(scrapeQueue);

describe("reconcileConcurrencyQueue", () => {
  beforeEach(() => {
    jest.resetAllMocks();

    getACUCTeamMock.mockResolvedValue({ concurrency: 1 } as never);
    getRedisConnectionMock.mockReturnValue({
      zscan: jest.fn().mockResolvedValue(["0", []]),
      smembers: jest.fn().mockResolvedValue([]),
    } as never);
    getConcurrencyLimitActiveJobsMock.mockResolvedValue([]);
    getNextConcurrentJobMock.mockResolvedValue(null);
    getCrawlMock.mockResolvedValue(null as never);
    scrapeQueueMock.getBackloggedJobIDsOfOwner.mockResolvedValue([]);
    scrapeQueueMock.getJobsFromBacklog.mockResolvedValue([]);
    scrapeQueueMock.getJobs.mockResolvedValue([]);
    scrapeQueueMock.promoteJobFromBacklogOrAdd.mockResolvedValue(null);
  });

  it("requeues blocked jobs in one batch after draining", async () => {
    scrapeQueueMock.getBackloggedJobIDsOfOwner.mockResolvedValue(["job-1", "job-2"]);
    getRedisConnectionMock.mockReturnValue({
      zscan: jest.fn().mockResolvedValue(["0", ["job-1", "0", "job-2", "0"]]),
      smembers: jest.fn().mockResolvedValue(["job-1", "job-2"]),
    } as never);
    getConcurrencyLimitActiveJobsMock.mockResolvedValue(["active-crawl"]);
    scrapeQueueMock.getJobs.mockResolvedValue([
      { id: "active-crawl", data: { team_id: "team-1" } },
    ] as never);
    getNextConcurrentJobMock
      .mockResolvedValueOnce({
        job: {
          id: "job-1",
          data: { team_id: "team-1", is_extract: true },
          priority: 1,
          listenable: false,
        },
        timeout: 1234,
      } as never)
      .mockResolvedValueOnce(null);

    await reconcileConcurrencyQueue({ teamId: "team-1" });

    expect(pushConcurrencyLimitedJobsMock).toHaveBeenCalledTimes(1);
    expect(pushConcurrencyLimitedJobsMock.mock.calls[0]?.[1]).toHaveLength(1);
    expect(pushConcurrencyLimitedJobsMock.mock.calls[0]?.[1][0]?.job.id).toBe("job-1");
    expect(pushConcurrencyLimitedJobsMock.mock.calls[0]?.[1][0]?.timeout).toBe(1234);
  });
});
