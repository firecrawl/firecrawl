import type { Response } from "express";
import type { Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  getCrawl: vi.fn(),
  getGroup: vi.fn(),
  addScrapeJobs: vi.fn(),
  addCrawlJobs: vi.fn(),
  saveCrawl: vi.fn(),
  markCrawlActive: vi.fn(),
  finishCrawlKickoff: vi.fn(),
  lockURLs: vi.fn().mockResolvedValue(true),
  isUrlBlocked: vi.fn().mockReturnValue(false),
}));

vi.mock("@mendable/firecrawl-rs", () => ({
  validateRegexes: vi.fn(),
  extractLinks: vi.fn(),
  filterLinks: vi.fn(),
  filterUrl: vi.fn(),
  extractAttributes: vi.fn(),
  extractImages: vi.fn(),
  extractMetadata: vi.fn(),
  transformHtml: vi.fn(),
  postProcessMarkdown: vi.fn(),
}));

vi.mock("../../../lib/crawl-redis", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/crawl-redis")>()),
  getCrawl: mocks.getCrawl,
  saveCrawl: mocks.saveCrawl,
  markCrawlActive: mocks.markCrawlActive,
  finishCrawlKickoff: mocks.finishCrawlKickoff,
  lockURLs: mocks.lockURLs,
  addCrawlJobs: mocks.addCrawlJobs,
}));

vi.mock("../../../services/worker/nuq-router", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../../services/worker/nuq-router")
  >()),
  crawlGroup: {
    addGroup: vi.fn(),
    getGroup: mocks.getGroup,
  },
  resolveNewGroupBackend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../services/queue-jobs", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../services/queue-jobs")>()),
  addScrapeJobs: mocks.addScrapeJobs,
}));

vi.mock("../../../scraper/WebScraper/utils/blocklist", () => ({
  isUrlBlocked: mocks.isUrlBlocked,
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn(),
}));

import { batchScrapeController } from "../batch-scrape";
import type { BatchScrapeResponse, RequestWithAuth } from "../types";

describe("batchScrapeController appendToId validation", () => {
  const teamId = "123e4567-e89b-12d3-a456-426614174000";
  const batchId = "123e4567-e89b-12d3-a456-426614174001";

  const buildReq = (appendToId?: string) =>
    ({
      headers: {},
      body: {
        urls: ["https://example.com/page"],
        ...(appendToId ? { appendToId } : {}),
      },
      auth: { team_id: teamId },
    }) as unknown as RequestWithAuth<any, BatchScrapeResponse, any>;

  const buildRes = () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response<BatchScrapeResponse>;
    return res;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when appendToId crawl is not found", async () => {
    mocks.getCrawl.mockResolvedValue(null);
    const req = buildReq(batchId);
    const res = buildRes();

    await batchScrapeController(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Job not found",
    });
  });

  it("returns 404 when appendToId belongs to another team", async () => {
    mocks.getCrawl.mockResolvedValue({
      team_id: "other-team-id",
      internalOptions: {},
    });
    const req = buildReq(batchId);
    const res = buildRes();

    await batchScrapeController(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Job not found",
    });
  });

  it("returns 409 when appending to a completed batch", async () => {
    mocks.getCrawl.mockResolvedValue({
      team_id: teamId,
      internalOptions: {},
    });
    mocks.getGroup.mockResolvedValue({
      id: batchId,
      ownerId: teamId,
      status: "completed",
    });
    const req = buildReq(batchId);
    const res = buildRes();

    await batchScrapeController(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Cannot append to a completed batch. Please start a new batch.",
    });
  });

  it("returns 409 when appending to a cancelled batch", async () => {
    mocks.getCrawl.mockResolvedValue({
      team_id: teamId,
      cancelled: true,
      internalOptions: {},
    });
    mocks.getGroup.mockResolvedValue({
      id: batchId,
      ownerId: teamId,
      status: "cancelled",
    });
    const req = buildReq(batchId);
    const res = buildRes();

    await batchScrapeController(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Cannot append to a cancelled batch. Please start a new batch.",
    });
  });

  it("allows appending to an active batch", async () => {
    mocks.getCrawl.mockResolvedValue({
      team_id: teamId,
      internalOptions: {},
    });
    mocks.getGroup.mockResolvedValue({
      id: batchId,
      ownerId: teamId,
      status: "active",
    });
    const req = buildReq(batchId);
    const res = buildRes();

    await batchScrapeController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        id: batchId,
      }),
    );
  });
});
