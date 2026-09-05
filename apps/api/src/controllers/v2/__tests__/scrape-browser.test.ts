import type { Response } from "express";
import { vi } from "vitest";
import { config } from "../../../config";
import { supabaseGetScrapeById } from "../../../lib/supabase-jobs";
import { scrapeInteractController } from "../scrape-browser";
import type { RequestWithAuth } from "../types";

vi.mock("uuid", () => ({
  v7: vi.fn(() => "session-123"),
}));

vi.mock("../../../lib/supabase-jobs", () => ({
  supabaseGetScrapeById: vi.fn(),
}));

vi.mock("../../../lib/browser-sessions", () => ({
  insertBrowserSession: vi.fn(),
  getBrowserSession: vi.fn(),
  updateBrowserSessionActivity: vi.fn(() => Promise.resolve()),
  updateBrowserSessionCreditsUsed: vi.fn(() => Promise.resolve()),
  updateBrowserSessionScrapeId: vi.fn(() => Promise.resolve()),
  claimBrowserSessionDestroyed: vi.fn(),
  markBrowserSessionCreationFailed: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../../../lib/keyless", () => ({
  keylessTeamUuid: vi.fn().mockReturnValue("keyless-team"),
  reserveKeylessCredits: vi.fn().mockResolvedValue({ allowed: true }),
  keylessLimitBody: vi.fn().mockReturnValue({ success: false }),
  KEYLESS_FREE_TIER_LIMIT_MESSAGE: "Free tier limit reached",
  adjustKeylessCredits: vi.fn().mockResolvedValue(null),
  logKeylessCreditUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../services/worker/nuq-router", () => ({
  getCombinedTeamActiveCount: vi.fn().mockResolvedValue(0),
  mirrorExternalSlotAcquire: vi.fn().mockResolvedValue(undefined),
  mirrorExternalSlotRelease: vi.fn().mockResolvedValue(undefined),
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
  });
});

import { scrapeStopInteractiveBrowserController } from "../scrape-browser";
import {
  getBrowserSessionFromScrape,
  invalidateActiveBrowserSessionCount,
  didBrowserSessionUsePrompt,
  claimBrowserSessionDestroyed,
} from "../../../lib/browser-sessions";
import { browserServiceRequest } from "../../../lib/scrape-interact/browser-service-client";
import { adjustKeylessCredits } from "../../../lib/keyless";

describe("browser teardown Redis failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBrowserSessionFromScrape).mockResolvedValue({
      id: "session",
      team_id: "team",
      browser_id: "browser",
      ttl_total: 60,
    } as any);
    vi.mocked(browserServiceRequest).mockResolvedValue({
      ok: true,
      cleanupQueued: true,
      sessionDurationMs: 60000,
    });
    vi.mocked(didBrowserSessionUsePrompt).mockResolvedValue(true);
  });
  it.each([
    invalidateActiveBrowserSessionCount,
    didBrowserSessionUsePrompt,
    adjustKeylessCredits,
  ])("propagates Redis failure before claiming billing", async operation => {
    const error = new Error("original Redis failure");
    vi.mocked(operation).mockRejectedValueOnce(error);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await expect(
      scrapeStopInteractiveBrowserController(
        { params: { jobId: "scrape" }, auth: { team_id: "team" } } as any,
        res,
      ),
    ).rejects.toBe(error);
    expect(claimBrowserSessionDestroyed).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
