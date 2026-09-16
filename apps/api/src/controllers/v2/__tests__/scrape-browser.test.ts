import type { Response } from "express";
import { vi } from "vitest";
import { config } from "../../../config";
import { logger } from "../../../lib/logger";
import { supabaseGetScrapeById } from "../../../lib/supabase-jobs";
import { scrapeInteractController } from "../scrape-browser";
import type { RequestWithAuth } from "../types";

vi.mock("uuid", () => ({
  v7: vi.fn(() => "session-123"),
}));

vi.mock("../../../lib/supabase-jobs", () => ({
  supabaseGetScrapeById: vi.fn(),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../../lib/browser-sessions", () => ({
  insertBrowserSession: vi.fn(),
  getBrowserSession: vi.fn(),
  updateBrowserSessionActivity: vi.fn(() => Promise.resolve()),
  updateBrowserSessionCreditsUsed: vi.fn(() => Promise.resolve()),
  updateBrowserSessionScrapeId: vi.fn(() => Promise.resolve()),
  claimBrowserSessionDestroyed: vi.fn(),
  invalidateActiveBrowserSessionCount: vi.fn(() => Promise.resolve()),
  getBrowserSessionFromScrape: vi.fn(),
  markBrowserSessionUsedPrompt: vi.fn(() => Promise.resolve()),
  didBrowserSessionUsePrompt: vi.fn(),
  clearBrowserSessionPromptFlag: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../lib/concurrency-limit", () => ({
  getConcurrencyLimitActiveJobsCount: vi.fn(),
  pushConcurrencyLimitActiveJob: vi.fn(() => Promise.resolve()),
  removeConcurrencyLimitActiveJob: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../lib/scrape-interact/browser-service-client", () => ({
  browserServiceRequest: vi.fn(),
  BrowserServiceError: class BrowserServiceError extends Error {
    status = 500;
  },
}));

vi.mock("../../../lib/scrape-interact/browser-agent", () => ({
  executePromptViaBrowserAgent: vi.fn(),
  executeCodeViaBrowserSession: vi.fn(),
}));

vi.mock("../../../lib/browser-session-activity", () => ({
  enqueueBrowserSessionActivity: vi.fn(),
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn(),
}));

vi.mock("../../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: vi.fn(),
  },
}));

describe("scrapeInteractController", () => {
  const previousUseDbAuthentication = config.USE_DB_AUTHENTICATION;

  const buildRes = () =>
    ({
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }) as unknown as Response;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    config.USE_DB_AUTHENTICATION = previousUseDbAuthentication;
  });

  it("rejects self-hosted scrape interact before querying Supabase", async () => {
    config.USE_DB_AUTHENTICATION = false;

    const req = {
      params: { jobId: "scrape-123" },
      body: { prompt: "click the first result" },
      auth: { team_id: "team-123" },
      acuc: {},
    } as RequestWithAuth<{ jobId: string }, any, any>;
    const res = buildRes();

    await scrapeInteractController(req, res);

    expect(supabaseGetScrapeById).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(501);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error:
        "Scrape interact requires stored scrape context and is not available when database authentication is disabled.",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Interact request rejected",
      expect.objectContaining({
        status: 501,
        reason: "db_auth_disabled",
        scrapeAgeMs: null,
      }),
    );
  });

  it("returns 404 and logs a structured rejection when the scrape row is not found", async () => {
    config.USE_DB_AUTHENTICATION = true;
    vi.mocked(supabaseGetScrapeById).mockResolvedValue(null);

    // A UUIDv7 job id, so scrapeAgeMs can be derived from it.
    const jobId = "01941f29-7c00-7abc-8def-0123456789ab";
    const req = {
      params: { jobId },
      body: { prompt: "click the first result" },
      auth: { team_id: "team-123" },
      acuc: {},
    } as RequestWithAuth<{ jobId: string }, any, any>;
    const res = buildRes();

    await scrapeInteractController(req, res);

    expect(supabaseGetScrapeById).toHaveBeenCalledWith(jobId);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Job not found.",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Interact request rejected",
      expect.objectContaining({
        canonicalLog: "api/v2/scrapeInteract",
        outcome: "rejected",
        status: 404,
        reason: "scrape_not_found",
        source: "replica",
        lookupMs: expect.any(Number),
        scrapeAgeMs: expect.any(Number),
      }),
    );
  });
});
