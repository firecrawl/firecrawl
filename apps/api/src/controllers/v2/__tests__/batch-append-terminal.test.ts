import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mendable/firecrawl-rs", () => ({
  validateRegexes: vi.fn().mockReturnValue(true),
  extractLinks: vi.fn().mockReturnValue([]),
  filterLinks: vi.fn().mockReturnValue([]),
  filterUrl: vi.fn().mockReturnValue(true),
}));

const mocks = vi.hoisted(() => ({
  getCrawl: vi.fn(),
  getGroup: vi.fn(),
  addScrapeJobs: vi.fn(),
  logRequest: vi.fn(),
  billTeam: vi.fn(),
}));

vi.mock("../../../lib/crawl-redis", () => ({
  getCrawl: mocks.getCrawl,
  saveCrawl: vi.fn(),
  markCrawlActive: vi.fn(),
  finishCrawlKickoff: vi.fn(),
  lockURLs: vi.fn(),
  addCrawlJobs: vi.fn(),
  setPageCount: vi.fn(),
}));

vi.mock("../../../services/worker/nuq-router", () => ({
  crawlGroup: {
    getGroup: mocks.getGroup,
    addGroup: vi.fn(),
  },
  scrapeQueue: {
    addJobs: mocks.addScrapeJobs,
  },
  resolveNewGroupBackend: vi.fn().mockResolvedValue("postgres"),
  resolveJobBackend: vi.fn().mockResolvedValue("postgres"),
}));

vi.mock("../../../services/redis", () => ({
  redisClient: {
    get: vi.fn(),
    set: vi.fn(),
  },
  redisEvictConnection: {
    scard: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock("../../../lib/logging/log_job", () => ({
  logRequest: mocks.logRequest,
  externalRequestId: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../lib/request-credits-store", () => ({
  initializeRequestCredits: vi.fn().mockResolvedValue(undefined),
  requestCreditsShards: vi.fn().mockReturnValue(1),
  AGENT_REQUEST_CREDITS_SHARDS: 1,
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: mocks.billTeam,
}));

vi.mock("../../../lib/threat-protection", () => ({
  checkUrlsAgainstThreatPolicy: vi.fn().mockResolvedValue({
    blocked: [],
    decisionsByUrl: new Map(),
  }),
  calculateThreatScanCredits: vi.fn().mockReturnValue(0),
  getThreatProtectionState: vi.fn().mockResolvedValue({ policy: null }),
}));

vi.mock("../../../lib/safe-mode", () => ({
  resolveSafeMode: vi.fn().mockReturnValue({ bypassed: false }),
  getSafeModeState: vi.fn().mockResolvedValue({ bypassed: false }),
}));

vi.mock("../../../scraper/WebScraper/utils/blocklist", () => ({
  isUrlBlocked: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../lib/default-anti-bot", () => ({
  isDefaultAntiBotEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { batchScrapeController } from "../batch-scrape";

const TEAM_ID = "123e4567-e89b-42d3-a456-426614174000";
const APPEND_TO_ID = "123e4567-e89b-42d3-a456-426614174001";

function makeReq(body: Record<string, any> = {}) {
  return {
    body: {
      urls: ["https://example.com/test-append"],
      ...body,
    },
    auth: { team_id: TEAM_ID },
    acuc: { team_id: TEAM_ID },
    headers: {},
  } as any;
}

function makeRes() {
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("batch-scrape appendToId terminal guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects append to a completed batch with 409 Conflict", async () => {
    mocks.getCrawl.mockResolvedValue({
      team_id: TEAM_ID,
      cancelled: false,
      createdAt: Date.now() - 60000,
      internalOptions: {},
    });
    mocks.getGroup.mockResolvedValue({
      id: APPEND_TO_ID,
      status: "completed",
    });

    const req = makeReq({ appendToId: APPEND_TO_ID });
    const res = makeRes();

    await batchScrapeController(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error:
        'Cannot append to a batch with status "completed". Please start a new batch without appendToId.',
    });
    expect(mocks.addScrapeJobs).not.toHaveBeenCalled();
    expect(mocks.logRequest).not.toHaveBeenCalled();
  });

  it("rejects append to a cancelled batch with 409 Conflict", async () => {
    mocks.getCrawl.mockResolvedValue({
      team_id: TEAM_ID,
      cancelled: true,
      createdAt: Date.now() - 60000,
      internalOptions: {},
    });
    mocks.getGroup.mockResolvedValue({
      id: APPEND_TO_ID,
      status: "active",
    });

    const req = makeReq({ appendToId: APPEND_TO_ID });
    const res = makeRes();

    await batchScrapeController(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error:
        'Cannot append to a batch with status "cancelled". Please start a new batch without appendToId.',
    });
    expect(mocks.addScrapeJobs).not.toHaveBeenCalled();
    expect(mocks.logRequest).not.toHaveBeenCalled();
  });

  it("rejects append to a missing batch with 404 Not Found", async () => {
    mocks.getCrawl.mockResolvedValue(null);
    mocks.getGroup.mockResolvedValue(null);

    const req = makeReq({ appendToId: APPEND_TO_ID });
    const res = makeRes();

    await batchScrapeController(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Job not found",
    });
    expect(mocks.addScrapeJobs).not.toHaveBeenCalled();
  });
});
