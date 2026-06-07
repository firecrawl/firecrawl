import type { Response } from "express";
import { config } from "../../../config";
import { supabaseGetScrapeById } from "../../../lib/supabase-jobs";
import { scrapeInteractController } from "../scrape-browser";
import type { RequestWithAuth } from "../types";

jest.mock("uuid", () => ({
  v7: jest.fn(() => "session-123"),
}));

jest.mock("../../../lib/supabase-jobs", () => ({
  supabaseGetScrapeById: jest.fn(),
}));

jest.mock("../../../lib/browser-sessions", () => ({
  insertBrowserSession: jest.fn(),
  getBrowserSession: jest.fn(),
  updateBrowserSessionActivity: jest.fn(() => Promise.resolve()),
  updateBrowserSessionCreditsUsed: jest.fn(() => Promise.resolve()),
  updateBrowserSessionScrapeId: jest.fn(() => Promise.resolve()),
  claimBrowserSessionDestroyed: jest.fn(),
  invalidateActiveBrowserSessionCount: jest.fn(() => Promise.resolve()),
  getBrowserSessionFromScrape: jest.fn(),
  markBrowserSessionUsedPrompt: jest.fn(() => Promise.resolve()),
  didBrowserSessionUsePrompt: jest.fn(),
  clearBrowserSessionPromptFlag: jest.fn(() => Promise.resolve()),
}));

jest.mock("../../../lib/concurrency-limit", () => ({
  getConcurrencyLimitActiveJobsCount: jest.fn(),
  pushConcurrencyLimitActiveJob: jest.fn(() => Promise.resolve()),
  removeConcurrencyLimitActiveJob: jest.fn(() => Promise.resolve()),
}));

jest.mock("../../../lib/scrape-interact/browser-service-client", () => ({
  browserServiceRequest: jest.fn(),
  BrowserServiceError: class BrowserServiceError extends Error {
    status = 500;
  },
}));

jest.mock("../../../lib/scrape-interact/browser-agent", () => ({
  executePromptViaBrowserAgent: jest.fn(),
  executeCodeViaBrowserSession: jest.fn(),
}));

jest.mock("../../../lib/browser-session-activity", () => ({
  enqueueBrowserSessionActivity: jest.fn(),
}));

jest.mock("../../../services/billing/credit_billing", () => ({
  billTeam: jest.fn(() => Promise.resolve()),
}));

jest.mock("../../../services/logging/log_job", () => ({
  logRequest: jest.fn(),
}));

jest.mock("../../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: jest.fn(),
  },
}));

describe("scrapeInteractController", () => {
  const previousUseDbAuthentication = config.USE_DB_AUTHENTICATION;

  const buildRes = () =>
    ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }) as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
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
  });
});
