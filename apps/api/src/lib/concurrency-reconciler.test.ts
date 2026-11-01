import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeOwnerId } from "./owner-id";
import { constructQueueKey, getNextConcurrentJob } from "./concurrency-limit";
import { constructConcurrencyLimitKey } from "./concurrency-redis";

const { mockRedis, mockScrapeQueue, mockGetCrawl, mockGetACUCTeam } =
  vi.hoisted(() => {
    return {
      mockRedis: {
        zscan: vi.fn(),
        smembers: vi.fn(),
        zrange: vi.fn(),
        zadd: vi.fn(),
        zrem: vi.fn(),
        del: vi.fn(),
        get: vi.fn(),
        zrangebyscore: vi.fn(),
        pipeline: vi.fn(),
      },
      mockScrapeQueue: {
        getBackloggedJobIDsOfOwner: vi.fn(),
        getBackloggedOwnerIDs: vi.fn(),
        getJobsFromBacklog: vi.fn(),
        getJobs: vi.fn(),
        promoteJobFromBacklogOrAdd: vi.fn(),
      },
      mockGetCrawl: vi.fn(),
      mockGetACUCTeam: vi.fn(),
    };
  });

vi.mock("../services/queue-service", () => ({
  getRedisConnection: () => mockRedis,
}));

vi.mock("../services/worker/nuq", () => ({
  scrapeQueue: mockScrapeQueue,
}));

vi.mock("./crawl-redis", () => ({
  getCrawl: mockGetCrawl,
}));

vi.mock("../controllers/auth", () => ({
  getACUCTeam: mockGetACUCTeam,
}));

import { reconcileConcurrencyQueue } from "./concurrency-queue-reconciler";

describe("Concurrency limiter & reconciler improvements (Issue #5415)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Queue & concurrency limiter key normalization", () => {
    it("normalizes non-UUID team IDs like 'bypass' to deterministic UUIDs", () => {
      const bypassQueueKey = constructQueueKey("bypass");
      const bypassLimiterKey = constructConcurrencyLimitKey("bypass");
      const normalizedBypass = normalizeOwnerId("bypass")!;

      expect(bypassQueueKey).toBe(
        `concurrency-limit-queue:${normalizedBypass}`,
      );
      expect(bypassLimiterKey).toBe(`concurrency-limiter:${normalizedBypass}`);
      expect(bypassQueueKey).not.toBe("concurrency-limit-queue:bypass");
    });

    it("leaves already valid UUIDs unchanged", () => {
      const uuid = "a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab";
      expect(constructQueueKey(uuid)).toBe(`concurrency-limit-queue:${uuid}`);
      expect(constructConcurrencyLimitKey(uuid)).toBe(
        `concurrency-limiter:${uuid}`,
      );
    });
  });

  describe("reconcileConcurrencyQueue owner resolution", () => {
    it("preserves non-UUID keys from concurrency-limit-queues by normalizing them", async () => {
      const normalizedBypass = normalizeOwnerId("bypass")!;
      mockScrapeQueue.getBackloggedOwnerIDs.mockResolvedValue([]);
      mockRedis.smembers.mockResolvedValue([
        "concurrency-limit-queue:bypass",
        `concurrency-limit-queue:${normalizedBypass}`,
      ]);

      mockRedis.zscan.mockResolvedValue(["0", []]);
      mockScrapeQueue.getBackloggedJobIDsOfOwner.mockResolvedValue([]);
      mockGetACUCTeam.mockResolvedValue({ concurrency_limit: 10 });
      mockRedis.zrangebyscore.mockResolvedValue([]);
      mockScrapeQueue.getJobs.mockResolvedValue([]);
      mockRedis.zrange.mockResolvedValue([]);

      const result = await reconcileConcurrencyQueue();

      // "bypass" must be normalized to UUID rather than dropped by isUUID
      expect(result.teamsScanned).toBe(1);
    });

    it("normalizes scoped teamId option", async () => {
      const normalizedBypass = normalizeOwnerId("bypass")!;
      mockScrapeQueue.getBackloggedJobIDsOfOwner.mockResolvedValue([]);
      mockRedis.zscan.mockResolvedValue(["0", []]);
      mockGetACUCTeam.mockResolvedValue({ concurrency_limit: 10 });
      mockRedis.zrangebyscore.mockResolvedValue([]);
      mockScrapeQueue.getJobs.mockResolvedValue([]);
      mockRedis.zrange.mockResolvedValue([]);

      await reconcileConcurrencyQueue({ teamId: "bypass" });

      expect(mockScrapeQueue.getBackloggedJobIDsOfOwner).toHaveBeenCalledWith(
        normalizedBypass,
        expect.anything(),
      );
    });
  });

  describe("reconcileTeam maxConcurrency adherence", () => {
    it("respects crawl maxConcurrency when recovering backlogged jobs instead of starting all at once", async () => {
      const teamId = "e029b35b-d362-4b2a-9e1e-2921cb927bb1";
      const crawlId = "crawl-batch-1";

      mockRedis.zscan.mockResolvedValue(["0", []]); // Redis has 0 jobs
      mockScrapeQueue.getBackloggedJobIDsOfOwner.mockResolvedValue([
        "job-1",
        "job-2",
        "job-3",
      ]);

      const mockJobs = [
        {
          id: "job-1",
          data: { crawl_id: crawlId, team_id: teamId },
          priority: 1,
        },
        {
          id: "job-2",
          data: { crawl_id: crawlId, team_id: teamId },
          priority: 1,
        },
        {
          id: "job-3",
          data: { crawl_id: crawlId, team_id: teamId },
          priority: 1,
        },
      ];
      mockScrapeQueue.getJobsFromBacklog.mockResolvedValue(mockJobs);
      mockGetACUCTeam.mockResolvedValue({ concurrency_limit: 100 }); // High team limit

      // Active jobs for the team: 0
      mockRedis.zrangebyscore.mockImplementation((key: string) => {
        if (key.includes("crawl-concurrency-limiter")) return [];
        return [];
      });
      mockScrapeQueue.getJobs.mockResolvedValue([]);

      // Crawl has maxConcurrency: 1
      mockGetCrawl.mockResolvedValue({
        team_id: teamId,
        maxConcurrency: 1,
        crawlerOptions: null,
      });

      mockScrapeQueue.promoteJobFromBacklogOrAdd.mockResolvedValue({
        id: "job-1",
      });
      mockRedis.pipeline.mockReturnValue({
        set: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        sadd: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      });

      // For drainQueue
      mockRedis.zrange.mockResolvedValue([]);

      const result = await reconcileConcurrencyQueue({ teamId });

      // With maxConcurrency: 1, only 1 job should be started; the other 2 should be requeued!
      expect(result.jobsStarted).toBe(1);
      expect(result.jobsRequeued).toBe(2);
      expect(mockScrapeQueue.promoteJobFromBacklogOrAdd).toHaveBeenCalledTimes(
        1,
      );
    });
  });

  describe("Crash-safe getNextConcurrentJob", () => {
    it("leaves crawl-blocked jobs in Redis without popping them into memory", async () => {
      const teamId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
      const crawlId = "crawl-blocked-test";
      const now = Date.now();

      // Return 2 candidates from zrange
      mockRedis.zrange.mockResolvedValueOnce([
        "job-blocked",
        String(now + 60000),
        "job-eligible",
        String(now + 60000),
      ]);

      mockRedis.get.mockImplementation(async (key: string) => {
        if (key === "cq-job:job-blocked") {
          return JSON.stringify({
            id: "job-blocked",
            data: { crawl_id: crawlId, team_id: teamId },
            priority: 1,
            listenable: false,
          });
        }
        if (key === "cq-job:job-eligible") {
          return JSON.stringify({
            id: "job-eligible",
            data: { crawl_id: "crawl-free", team_id: teamId },
            priority: 1,
            listenable: false,
          });
        }
        return null;
      });

      mockGetCrawl.mockImplementation(async (id: string) => {
        if (id === crawlId) {
          return { team_id: teamId, maxConcurrency: 1, crawlerOptions: null };
        }
        return { team_id: teamId, maxConcurrency: 5, crawlerOptions: null };
      });

      // crawlId is already at active concurrency 1
      mockRedis.zrangebyscore.mockImplementation(async (key: string) => {
        if (key.includes(crawlId)) return ["active-job-x"];
        return [];
      });

      mockRedis.zrem.mockResolvedValue(1);
      mockRedis.del.mockResolvedValue(1);

      const next = await getNextConcurrentJob(teamId);

      // "job-blocked" should NEVER have been zrem-ed!
      expect(mockRedis.zrem).not.toHaveBeenCalledWith(
        expect.stringContaining("concurrency-limit-queue"),
        "job-blocked",
      );

      // "job-eligible" should be claimed and returned
      expect(next).not.toBeNull();
      expect(next?.job.id).toBe("job-eligible");
      expect(mockRedis.zrem).toHaveBeenCalledWith(
        expect.stringContaining("concurrency-limit-queue"),
        "job-eligible",
      );
    });
  });
});
