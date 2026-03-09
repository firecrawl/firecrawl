import type { Response } from "express";
import type { RequestWithAuth } from "../types";
import { crawlStatusController } from "../crawl-status";
import { getCrawl, getCrawlExpiry } from "../../../lib/crawl-redis";
import { crawlGroup, normalizeOwnerId, scrapeQueue } from "../../../services/worker/nuq";

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

describe("v1 crawlStatusController consistency", () => {
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
  });

  it("returns 200 when Redis crawl is missing but any NuQ job exists", async () => {
    const jobId = "job-123";
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
      expect.objectContaining({
        success: true,
        status: "scraping",
        total: 0,
        completed: 0,
      }),
    );
    // Should not depend on Redis TTL when `sc` is missing
    expect(getCrawlExpiry).not.toHaveBeenCalled();
  });

  it("returns 200 when group is missing but a job exists for the group", async () => {
    const jobId = "job-123";
    const createdAt = new Date("2026-01-01T00:00:00Z");

    (crawlGroup.getGroup as jest.Mock).mockResolvedValue(null);
    (scrapeQueue.getGroupAnyJob as jest.Mock).mockResolvedValue({
      id: "kickoff-1",
      status: "queued",
      createdAt,
      priority: 0,
      data: { zeroDataRetention: false },
      groupId: jobId,
      ownerId: "bypass",
    });
    (getCrawl as jest.Mock).mockResolvedValue(null);
    (scrapeQueue.getGroupNumericStats as jest.Mock).mockResolvedValue({});
    (scrapeQueue.getCrawlJobsForListing as jest.Mock).mockResolvedValue([]);

    const req = buildReq(jobId);
    const res = buildRes();

    await crawlStatusController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, status: "scraping" }),
    );

    const expiresAt = (res.json as jest.Mock).mock.calls[0]![0]!.expiresAt as string;
    expect(new Date(expiresAt).getTime()).toBe(createdAt.getTime() + 24 * 60 * 60 * 1000);
  });

  it("returns 404 when no backing state exists", async () => {
    const jobId = "job-123";
    (crawlGroup.getGroup as jest.Mock).mockResolvedValue(null);
    (scrapeQueue.getGroupAnyJob as jest.Mock).mockResolvedValue(null);
    (getCrawl as jest.Mock).mockResolvedValue(null);

    const req = buildReq(jobId);
    const res = buildRes();

    await crawlStatusController(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: "Job not found" }),
    );
  });
});

