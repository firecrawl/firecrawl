const getRedisConnection = vi.hoisted(() => vi.fn());
const reportPipelineError = vi.hoisted(() => vi.fn());

vi.mock("../services/queue-service", () => ({ getRedisConnection }));
vi.mock("./crawl-redis", () => ({ getCrawl: vi.fn() }));
vi.mock("./logger", () => ({ logger: { debug: vi.fn() } }));
vi.mock("../services/ab-test", () => ({ abTestJob: vi.fn() }));
vi.mock("../services/worker/nuq", () => ({ scrapeQueue: {} }));
vi.mock("../services/autumn/autumn.service", () => ({ autumnService: {} }));
vi.mock("./team-org", () => ({ orgIdForTeam: vi.fn() }));
vi.mock("./concurrency-redis", () => ({
  constructConcurrencyLimitKey: vi.fn(),
  getTeamQueueLimit: vi.fn(),
  MAX_BACKLOG_TIMEOUT_MS: 0,
  pushConcurrencyLimitActiveJob: vi.fn(),
  removeConcurrencyLimitActiveJob: vi.fn(),
}));
vi.mock("./redis-pipeline", () => ({ reportPipelineError }));

import { removeConcurrencyLimitedJobs } from "./concurrency-limit";

describe("removeConcurrencyLimitedJobs", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns true for an empty cleanup", async () => {
    await expect(removeConcurrencyLimitedJobs("team-1", [])).resolves.toBe(
      true,
    );
    expect(getRedisConnection).not.toHaveBeenCalled();
  });

  it("reports failure when any cleanup chunk has a command error", async () => {
    const pipeline = () => ({
      zrem: vi.fn(),
      del: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    });
    const pipelines = [pipeline(), pipeline()];
    getRedisConnection.mockReturnValue({
      pipeline: vi
        .fn()
        .mockReturnValueOnce(pipelines[0])
        .mockReturnValueOnce(pipelines[1]),
    });
    reportPipelineError
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(new Error("DEL failed"));

    await expect(
      removeConcurrencyLimitedJobs(
        "team-1",
        Array.from({ length: 1001 }, (_, index) => `job-${index}`),
      ),
    ).resolves.toBe(false);

    expect(reportPipelineError).toHaveBeenCalledTimes(2);
  });

  it("returns true when every cleanup chunk succeeds", async () => {
    const pipeline = {
      zrem: vi.fn(),
      del: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    };
    getRedisConnection.mockReturnValue({
      pipeline: vi.fn().mockReturnValue(pipeline),
    });
    reportPipelineError.mockReturnValue(null);

    await expect(
      removeConcurrencyLimitedJobs("team-1", ["job-1"]),
    ).resolves.toBe(true);
  });
});
