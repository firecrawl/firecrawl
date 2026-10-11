import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCrawl: vi.fn(),
  getGroup: vi.fn(),
  addScrapeJobs: vi.fn(),
  addCrawlJobs: vi.fn(),
  lockURLs: vi.fn(),
  finishCrawlKickoff: vi.fn(),
  resolveThreatProtection: vi.fn(),
  billTeam: vi.fn(),
  logRequest: vi.fn(),
}));

// Keep the test at the controller boundary: remote policy, billing, and queue
// services are independent of the append lifecycle precondition.
vi.mock("../../lib/crawl-redis", () => ({
  getCrawl: mocks.getCrawl,
  addCrawlJobs: mocks.addCrawlJobs,
  lockURLs: mocks.lockURLs,
  finishCrawlKickoff: mocks.finishCrawlKickoff,
  markCrawlActive: vi.fn(),
  saveCrawl: vi.fn(),
}));
vi.mock("../../services/worker/nuq-router", () => ({
  crawlGroup: { getGroup: mocks.getGroup, addGroup: vi.fn() },
  resolveNewGroupBackend: vi.fn().mockResolvedValue("pg"),
}));
vi.mock("../../services/queue-jobs", () => ({
  addScrapeJobs: mocks.addScrapeJobs,
}));
vi.mock("../../lib/threat-protection/request", () => ({
  resolveThreatProtection: mocks.resolveThreatProtection,
  checkUrlsAgainstThreatPolicy: vi.fn(),
}));
vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: mocks.billTeam,
}));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
}));
vi.mock("../../lib/job-priority", () => ({
  getJobPriority: vi.fn().mockResolvedValue(20),
}));
vi.mock("../../lib/permissions", () => ({
  checkPermissions: vi.fn(() => ({})),
}));
vi.mock("../../lib/safe-mode", () => ({ resolveSafeMode: vi.fn(() => ({})) }));
vi.mock("../../lib/key-restriction", () => ({
  checkKeyFormatRestriction: vi.fn().mockResolvedValue({ allowed: true }),
  actionTypesOf: vi.fn(() => []),
  formatTypesOf: vi.fn(() => []),
}));
vi.mock("../../scraper/WebScraper/utils/blocklist", () => ({
  isUrlBlocked: vi.fn(() => false),
}));
vi.mock("../../lib/zdr-helpers", () => ({
  getScrapeZDR: vi.fn(() => "allowed"),
}));
vi.mock("../../lib/agent-interop", () => ({
  isAgentInteropSecretValid: vi.fn(() => true),
}));
vi.mock("../../lib/scrape-billing", () => ({
  calculateThreatScanCredits: vi.fn(() => 0),
}));
vi.mock("../../lib/siem-logging", () => ({
  emitRejectedScrapeActivityEvents: vi.fn(),
}));
vi.mock("../../lib/request-credits-store", () => ({
  requestCreditsShards: vi.fn(() => 1),
  initializeRequestCredits: vi.fn().mockResolvedValue(undefined),
  AGENT_REQUEST_CREDITS_SHARDS: 1,
}));
vi.mock("../../services/webhook", () => ({
  createWebhookSender: vi.fn(),
  WebhookEvent: { BATCH_SCRAPE_STARTED: "batch_scrape.started" },
}));

// Validation itself has separate schema suites. Both controllers receive a
// valid parsed request with the same fields as an HTTP batch append.
vi.mock("../v1/types", () => ({
  batchScrapeRequestSchema: { parse: (body: unknown) => body },
  batchScrapeRequestSchemaNoURLValidation: { parse: (body: unknown) => body },
  url: { parse: (url: string) => url },
}));
vi.mock("../v2/types", () => ({
  batchScrapeRequestSchema: { parse: (body: unknown) => body },
  batchScrapeRequestSchemaNoURLValidation: { parse: (body: unknown) => body },
  URL: { parse: (url: string) => url },
  fromV1ScrapeOptions: (body: unknown) => ({
    scrapeOptions: body,
    internalOptions: {},
  }),
}));

import { batchScrapeController as v1 } from "../v1/batch-scrape";
import { batchScrapeController as v2 } from "../v2/batch-scrape";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "22222222-2222-4222-8222-222222222222";

function request() {
  return {
    body: {
      appendToId: BATCH_ID,
      urls: ["https://example.com/new"],
      formats: ["markdown"],
    },
    auth: { team_id: TEAM_ID },
    acuc: { flags: {} },
    protocol: "http",
    host: "localhost",
    get: vi.fn(),
    headers: {},
  } as any;
}

function response() {
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCrawl.mockReset().mockResolvedValue({
    team_id: TEAM_ID,
    createdAt: Date.now(),
    crawlerOptions: null,
    scrapeOptions: {},
    internalOptions: {},
  });
  mocks.getGroup.mockReset().mockResolvedValue({ status: "active" });
  mocks.resolveThreatProtection.mockResolvedValue({
    policy: null,
    orgConfig: null,
  });
});

function expectNoJobs() {
  expect(mocks.addScrapeJobs).not.toHaveBeenCalled();
  expect(mocks.addCrawlJobs).not.toHaveBeenCalled();
  expect(mocks.lockURLs).not.toHaveBeenCalled();
  expect(mocks.finishCrawlKickoff).not.toHaveBeenCalled();
}

describe.each([
  ["v1", v1],
  ["v2", v2],
] as const)("%s batch append lifecycle", (_version, controller) => {
  it.each(["completed", "cancelled"])(
    "rejects a %s group before policy/billing work",
    async status => {
      mocks.getGroup.mockResolvedValue({ status });
      const res = response();
      await controller(request(), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringMatching(/new batch/i),
      });
      expectNoJobs();
      expect(mocks.resolveThreatProtection).not.toHaveBeenCalled();
      expect(mocks.billTeam).not.toHaveBeenCalled();
      expect(mocks.logRequest).not.toHaveBeenCalled();
    },
  );

  it("rejects Redis-cancelled batches while their queue group is still active", async () => {
    mocks.getCrawl.mockResolvedValue({
      team_id: TEAM_ID,
      cancelled: true,
      internalOptions: {},
    });
    const res = response();
    await controller(request(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expectNoJobs();
  });

  it("rejects a batch that finishes while the append request is being prepared", async () => {
    mocks.getGroup
      .mockResolvedValueOnce({ status: "active" })
      .mockResolvedValue({ status: "completed" });
    const res = response();
    await controller(request(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expectNoJobs();
  });

  it("still appends to an active batch", async () => {
    const res = response();
    await controller(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.addScrapeJobs).toHaveBeenCalledOnce();
    expect(mocks.addScrapeJobs.mock.calls[0][0][0].data).toMatchObject({
      crawl_id: BATCH_ID,
      url: "https://example.com/new",
    });
  });

  it.each(["missing crawl", "missing group", "another team"])(
    "returns 404 for %s without enqueueing",
    async reason => {
      if (reason === "missing crawl") mocks.getCrawl.mockResolvedValue(null);
      if (reason === "missing group") mocks.getGroup.mockResolvedValue(null);
      if (reason === "another team")
        mocks.getCrawl.mockResolvedValue({ team_id: "another-team" });
      const res = response();
      await controller(request(), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expectNoJobs();
      expect(mocks.resolveThreatProtection).not.toHaveBeenCalled();
    },
  );
});
