import type { Response } from "express";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
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
  invalidateActiveBrowserSessionCount: vi.fn(() => Promise.resolve()),
  getBrowserSessionFromScrape: vi.fn(),
  markBrowserSessionUsedPrompt: vi.fn(() => Promise.resolve()),
  didBrowserSessionUsePrompt: vi.fn(),
  clearBrowserSessionPromptFlag: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../lib/concurrency-limit", () => ({
  getConcurrencyLimitActiveJobsCount: vi.fn(),
  getEffectiveConcurrencyLimit: vi.fn(() => Promise.resolve(10)),
  pushConcurrencyLimitActiveJob: vi.fn(() => Promise.resolve()),
  removeConcurrencyLimitActiveJob: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../services/worker/nuq-router", () => ({
  getCombinedTeamActiveCount: vi.fn(() => Promise.resolve(0)),
  mirrorExternalSlotAcquire: vi.fn(() => Promise.resolve()),
  mirrorExternalSlotRelease: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../lib/scrape-interact/browser-service-client", () => ({
  browserServiceRequest: vi.fn(),
  BrowserServiceError: class BrowserServiceError extends Error {
    status = 500;
  },
}));

vi.mock("../../../lib/scrape-interact/scrape-replay", () => ({
  buildReplayContextFromScrape: vi.fn(() => ({
    context: {
      targetUrl: "https://example.com",
      waitForMs: 0,
      actions: [],
    },
  })),
  estimateReplayTimeoutSeconds: vi.fn(() => 30),
  buildReplayScript: vi.fn(() => "// replay"),
}));

vi.mock("../../../lib/keyless", () => ({
  KEYLESS_FREE_TIER_LIMIT_MESSAGE: "Keyless limit reached",
  adjustKeylessCredits: vi.fn(() => Promise.resolve()),
  keylessTeamUuid: vi.fn(() => null),
  keylessLimitBody: vi.fn(() => ({ success: false, error: "Keyless limit" })),
  logKeylessCreditUsage: vi.fn(() => Promise.resolve()),
  reserveKeylessCredits: vi.fn(() => Promise.resolve({ ok: true })),
}));

vi.mock("../../../lib/agent-auth-discovery", () => ({
  applyAgentAuthDiscoveryHeader: vi.fn(),
}));

vi.mock("../../../lib/zdr-helpers", () => ({
  getScrapeZDR: vi.fn(() => null),
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
  });

  describe("ttl/activityTtl passthrough", () => {
    let browserServiceRequest: ReturnType<typeof vi.fn>;
    let insertBrowserSession: ReturnType<typeof vi.fn>;
    let getBrowserSessionFromScrape: ReturnType<typeof vi.fn>;
    let checkCredits: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      config.USE_DB_AUTHENTICATION = true;
      config.BROWSER_SERVICE_URL = "http://browser-service:3000";

      browserServiceRequest = (
        await import("../../../lib/scrape-interact/browser-service-client")
      ).browserServiceRequest as unknown as ReturnType<typeof vi.fn>;
      browserServiceRequest.mockResolvedValue({
        sessionId: "browser-svc-123",
        cdpUrl: "ws://cdp",
        iframeUrl: "ws://view",
        interactiveIframeUrl: "ws://interactive",
        expiresAt: new Date().toISOString(),
      });

      insertBrowserSession = (
        await import("../../../lib/browser-sessions")
      ).insertBrowserSession as unknown as ReturnType<typeof vi.fn>;
      insertBrowserSession.mockResolvedValue({
        id: "session-123",
        team_id: "team-123",
        browser_id: "browser-svc-123",
        status: "active",
        ttl_total: 600,
        ttl_without_activity: 300,
      });

      getBrowserSessionFromScrape = (
        await import("../../../lib/browser-sessions")
      ).getBrowserSessionFromScrape as unknown as ReturnType<typeof vi.fn>;
      getBrowserSessionFromScrape.mockResolvedValue(null);

      checkCredits = (
        await import("../../../services/autumn/autumn.service")
      ).autumnService.checkCredits as unknown as ReturnType<typeof vi.fn>;
      checkCredits.mockResolvedValue({ allowed: true });

      const scrape = {
        id: "scrape-123",
        team_id: "team-123",
        url: "https://example.com",
        options: {},
      };
      (supabaseGetScrapeById as ReturnType<typeof vi.fn>).mockResolvedValue(
        scrape,
      );
    });

    it("uses default ttl (600) and activityTtl (300) when not provided", async () => {
      const req = {
        params: { jobId: "scrape-123" },
        body: { code: "console.log('hi')" },
        auth: { team_id: "team-123" },
        acuc: {},
      } as RequestWithAuth<{ jobId: string }, any, any>;
      const res = buildRes();

      await scrapeInteractController(req, res);

      // browserServiceRequest is called for /exec after session creation
      expect(browserServiceRequest).toHaveBeenCalled();
      // The first call is POST /browsers (session creation)
      const createCall = browserServiceRequest.mock.calls.find(
        (call: any[]) => call[0] === "POST" && call[1] === "/browsers",
      );
      expect(createCall).toBeDefined();
      expect(createCall[2]).toMatchObject({
        ttl: 600,
        activityTtl: 300,
      });
    });

    it("passes user-provided ttl and activityTtl to browser service", async () => {
      const req = {
        params: { jobId: "scrape-123" },
        body: {
          code: "console.log('hi')",
          ttl: 120,
          activityTtl: 60,
        },
        auth: { team_id: "team-123" },
        acuc: {},
      } as RequestWithAuth<{ jobId: string }, any, any>;
      const res = buildRes();

      await scrapeInteractController(req, res);

      const createCall = browserServiceRequest.mock.calls.find(
        (call: any[]) => call[0] === "POST" && call[1] === "/browsers",
      );
      expect(createCall).toBeDefined();
      expect(createCall[2]).toMatchObject({
        ttl: 120,
        activityTtl: 60,
      });
    });

    it("passes only ttl when only ttl is provided (activityTtl uses default)", async () => {
      const req = {
        params: { jobId: "scrape-123" },
        body: {
          code: "console.log('hi')",
          ttl: 120,
        },
        auth: { team_id: "team-123" },
        acuc: {},
      } as RequestWithAuth<{ jobId: string }, any, any>;
      const res = buildRes();

      await scrapeInteractController(req, res);

      const createCall = browserServiceRequest.mock.calls.find(
        (call: any[]) => call[0] === "POST" && call[1] === "/browsers",
      );
      expect(createCall).toBeDefined();
      expect(createCall[2]).toMatchObject({
        ttl: 120,
        activityTtl: 300, // default
      });
    });

    it("rejects ttl below minimum (30)", async () => {
      const req = {
        params: { jobId: "scrape-123" },
        body: {
          code: "console.log('hi')",
          ttl: 10,
        },
        auth: { team_id: "team-123" },
        acuc: {},
      } as RequestWithAuth<{ jobId: string }, any, any>;
      const res = buildRes();

      // Zod validation throws (Express error middleware converts to 400)
      await expect(scrapeInteractController(req, res)).rejects.toThrow(
        /expected number to be >=30/,
      );
    });

    it("rejects activityTtl below minimum (10)", async () => {
      const req = {
        params: { jobId: "scrape-123" },
        body: {
          code: "console.log('hi')",
          activityTtl: 5,
        },
        auth: { team_id: "team-123" },
        acuc: {},
      } as RequestWithAuth<{ jobId: string }, any, any>;
      const res = buildRes();

      await expect(scrapeInteractController(req, res)).rejects.toThrow(
        /expected number to be >=10/,
      );
    });
  });
});
