import type { Logger } from "winston";
import {
  cancelScrapeJob,
  getScrapeJobCancellationReason,
  isScrapeJobCancelled,
  markScrapeJobCancelled,
} from "../job-cancellation";
import { redisEvictConnection } from "../redis";
import { scrapeQueue } from "../worker/nuq";
import {
  removeConcurrencyLimitActiveJob,
  removeConcurrencyLimitedJob,
  removeCrawlConcurrencyLimitActiveJob,
} from "../../lib/concurrency-limit";

jest.mock("../worker/nuq", () => ({
  scrapeQueue: {
    removeJob: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock("../../lib/concurrency-limit", () => ({
  removeConcurrencyLimitActiveJob: jest.fn().mockResolvedValue(true),
  removeConcurrencyLimitedJob: jest.fn().mockResolvedValue(true),
  removeCrawlConcurrencyLimitActiveJob: jest.fn().mockResolvedValue(true),
}));

jest.mock("../redis", () => ({
  redisEvictConnection: {
    set: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(0),
    get: jest.fn().mockResolvedValue(null),
  },
}));

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;

describe("cancelScrapeJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("marks the job cancelled and removes queue references", async () => {
    await cancelScrapeJob({
      jobId: "job-1",
      teamId: "team-1",
      crawlId: "crawl-1",
      reason: "client_disconnect",
      logger,
    });

    expect(redisEvictConnection.set).toHaveBeenCalledWith(
      "cancelled-scrape-job:" + "job-1",
      "client_disconnect",
      "EX",
      60 * 60,
    );
    expect(scrapeQueue.removeJob).toHaveBeenCalledWith("job-1", logger);
    expect(removeConcurrencyLimitActiveJob).toHaveBeenCalledWith(
      "team-1",
      "job-1",
    );
    expect(removeConcurrencyLimitedJob).toHaveBeenCalledWith("team-1", "job-1");
    expect(removeCrawlConcurrencyLimitActiveJob).toHaveBeenCalledWith(
      "crawl-1",
      "job-1",
    );
  });

  it("handles missing team/crawl gracefully", async () => {
    await cancelScrapeJob({
      jobId: "job-2",
      reason: "manual",
      logger,
    });

    expect(removeConcurrencyLimitActiveJob).not.toHaveBeenCalled();
    expect(removeCrawlConcurrencyLimitActiveJob).not.toHaveBeenCalled();
  });
});

describe("isScrapeJobCancelled / getScrapeJobCancellationReason", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns true when redis key exists", async () => {
    (redisEvictConnection.exists as jest.Mock).mockResolvedValueOnce(1);
    expect(await isScrapeJobCancelled("job-3")).toBe(true);
  });

  it("returns cancellation reason", async () => {
    (redisEvictConnection.get as jest.Mock).mockResolvedValueOnce(
      "client_disconnect",
    );
    expect(await getScrapeJobCancellationReason("job-4")).toBe(
      "client_disconnect",
    );
  });

  it("markScrapeJobCancelled sets TTL", async () => {
    await markScrapeJobCancelled("job-5", "manual");
    expect(redisEvictConnection.set).toHaveBeenCalledWith(
      "cancelled-scrape-job:job-5",
      "manual",
      "EX",
      60 * 60,
    );
  });
});
