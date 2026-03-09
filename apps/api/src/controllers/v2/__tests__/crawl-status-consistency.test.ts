import type { Response } from "express";
import type { RequestWithAuth } from "../types";
import { crawlStatusController } from "../crawl-status";
import { getCrawl, getCrawlExpiry } from "../../../lib/crawl-redis";
import { crawlGroup, normalizeOwnerId, scrapeQueue } from "../../../services/worker/nuq";
import { redisEvictConnection } from "../../../services/redis";

jest.mock("../../../lib/crawl-redis", () => ({
  getCrawl: jest.fn(),
  getCrawlExpiry: jest.fn(),
}));

jest.mock("../../../services/worker/nuq", () => ({
  crawlGroup: {
    getGroup: jest.fn(),
  },
  scrapeQueue: {
    getGroupAnyJob: jest.fn(),
    getGroupNumericStats: jest.fn(),
    getCrawlJobsForListing: jest.fn(),
  },
  normalizeOwnerId: jest.fn((x: string) => x),
}));

jest.mock("../../../services/redis", () => ({
  redisEvictConnection: {
    smembers: jest.fn(),
  },
}));

describe("v2 crawlStatusController consistency", () => {
  const buildReq = (jobId: string, teamId = "bypass") =>
    ({
      params: { jobId },
      query: {},
      auth: { team_id: teamId },
      protocol: "http",
      get: jest.fn().mockReturnValue("localhost"),
    }) as unknown as RequestWithAuth<{ jobId: string }, any, any>;

  const buildRes = () =>
    ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }) as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
    (redisEvictConnection.smembers as jest.Mock).mockResolvedValue([]);
  });

  it("returns 200 when Redis crawl is missing but any NuQ job exists", async () => {
    const jobId = "123e4567-e89b-12d3-a456-426614174000";

    (crawlGroup.getGroup as jest.Mock).mockResolvedValue({
      id: jobId,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      ownerId: "bypass",
      ttl: 24 * 60 * 60 * 1000,
      expiresAt: new Date("2026-01-02T00:00:00Z"),
    });
    (scrapeQueue.getGroupAnyJob as jest.Mock).mockResolvedValue({
      id: "kickoff-1",
      status: "queued",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      priority: 0,
      data: { zeroDataRetention: false },
      groupId: jobId,
      ownerId: "bypass",
    });
    (getCrawl as jest.Mock).mockResolvedValue(null);
    (scrapeQueue.getGroupNumericStats as jest.Mock).mockResolvedValue({});
    (scrapeQueue.getCrawlJobsForListing as jest.Mock).mockResolvedValue([]);
    (normalizeOwnerId as jest.Mock).mockReturnValue("bypass");

    const req = buildReq(jobId);
    const res = buildRes();

    await crawlStatusController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, status: "scraping" }),
    );
    expect(getCrawlExpiry).not.toHaveBeenCalled();
  });

  it("returns 404 for invalid job IDs", async () => {
    const req = buildReq("not-a-uuid");
    const res = buildRes();

    await crawlStatusController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: "Invalid job ID" }),
    );
  });
});

