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
} from "../../../lib/browser-sessions";
import { browserServiceRequest } from "../../../lib/scrape-interact/browser-service-client";
import { finalizeBrowserSession } from "../../../lib/browser-session-finalization";
import { logKeylessCreditUsage } from "../../../lib/keyless";
import { mirrorExternalSlotRelease } from "../../../services/worker/nuq-router";

vi.mock("../../../lib/browser-session-finalization", () => ({
  finalizeBrowserSession: vi.fn(),
  getBrowserSessionBillingDuration: vi.fn().mockResolvedValue(null),
}));

describe("browser teardown Redis failures", () => {
  const request = () =>
    ({
      params: { jobId: "scrape" },
      auth: { team_id: "team" },
      acuc: { api_key_id: 42 },
    }) as any;
  const response = () =>
    ({ status: vi.fn().mockReturnThis(), json: vi.fn() }) as any;
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
    vi.mocked(finalizeBrowserSession).mockResolvedValue({
      didFinalize: true,
      creditsBilled: 7,
      usedPrompt: true,
      rate: 420,
    });
  });
  it("passes session identity and confirmed duration to finalization after team cleanup", async () => {
    const res = response();
    await scrapeStopInteractiveBrowserController(request(), res);
    expect(getBrowserSessionFromScrape).toHaveBeenCalledWith("scrape");
    expect(invalidateActiveBrowserSessionCount).toHaveBeenCalledWith("team");
    expect(mirrorExternalSlotRelease).toHaveBeenCalledWith("team", "session");
    expect(finalizeBrowserSession).toHaveBeenCalledWith("session", 60000, 42);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      sessionDurationMs: 60000,
      creditsBilled: 7,
      cleanupQueued: true,
    });
  });
  it.each([invalidateActiveBrowserSessionCount, mirrorExternalSlotRelease])(
    "propagates cleanup Redis failure before finalization",
    async operation => {
      const error = new Error("original Redis failure");
      vi.mocked(operation).mockRejectedValueOnce(error);
      const res = response();
      await expect(
        scrapeStopInteractiveBrowserController(request(), res),
      ).rejects.toBe(error);
      expect(finalizeBrowserSession).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    },
  );
  it("retains both cleanup errors and never finalizes after either failure", async () => {
    const invalidate = new Error("invalidation failed"),
      release = new Error("release failed");
    vi.mocked(invalidateActiveBrowserSessionCount).mockRejectedValueOnce(
      invalidate,
    );
    vi.mocked(mirrorExternalSlotRelease).mockRejectedValueOnce(release);
    await expect(
      scrapeStopInteractiveBrowserController(request(), response()),
    ).rejects.toMatchObject({ errors: [invalidate, release] });
    expect(finalizeBrowserSession).not.toHaveBeenCalled();
  });
  it("records keyless usage only for the caller that finalizes the session", async () => {
    vi.mocked(finalizeBrowserSession)
      .mockResolvedValueOnce({
        creditsBilled: 7,
        usedPrompt: true,
        rate: 420,
        didFinalize: true,
      })
      .mockResolvedValueOnce({
        creditsBilled: 7,
        usedPrompt: false,
        rate: 0,
        didFinalize: false,
      });
    await scrapeStopInteractiveBrowserController(request(), response());
    await scrapeStopInteractiveBrowserController(request(), response());
    expect(logKeylessCreditUsage).toHaveBeenCalledTimes(1);
    expect(logKeylessCreditUsage).toHaveBeenCalledWith("team", 7);
  });
  it("propagates the original finalization failure without a success response", async () => {
    const error = new Error("original finalization failure");
    vi.mocked(finalizeBrowserSession).mockRejectedValueOnce(error);
    const res = response();
    await expect(
      scrapeStopInteractiveBrowserController(request(), res),
    ).rejects.toBe(error);
    expect(finalizeBrowserSession).toHaveBeenCalledWith("session", 60000, 42);
    expect(res.json).not.toHaveBeenCalled();
  });
});
