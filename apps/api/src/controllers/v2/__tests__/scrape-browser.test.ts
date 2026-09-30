import type { Response } from "express";
import { vi } from "vitest";
import { config } from "../../../config";
import { supabaseGetScrapeByIdDirect } from "../../../lib/supabase-jobs";
import {
  insertBrowserSession,
  getBrowserSession,
} from "../../../lib/browser-sessions";
import {
  createHangarBrowser,
  executeHangarBrowser,
  stopHangarBrowser,
  getHangarRecording,
} from "../../../lib/hangar";
import {
  browserExecuteController,
  browserDeleteController,
  browserReplayController,
  browserReplayPageController,
} from "../browser";
import { executeCodeViaBrowserSession } from "../../../lib/scrape-interact/browser-agent";
import { scrapeInteractController } from "../scrape-browser";
import type { RequestWithAuth } from "../types";

vi.mock("uuid", () => ({
  v7: vi.fn(() => "session-123"),
}));

vi.mock("../../../config", () => ({
  config: {
    USE_DB_AUTHENTICATION: true,
    HANGAR_URL: "http://localhost:9000",
  },
}));
vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));
vi.mock("../../../services/worker/nuq-router", () => ({
  scrapeQueue: { getJob: vi.fn(async () => null) },
  getCombinedTeamActiveCount: vi.fn(async () => 0),
  reserveExternalSlot: vi.fn(async () => true),
  mirrorExternalSlotRelease: vi.fn(async () => {}),
}));
vi.mock("../../../lib/operational-job-access", () => ({
  getScrapeJobAccess: vi.fn(async () => ({
    teamId: "team-123",
    expiresAtMs: Date.now() + 60_000,
  })),
}));
vi.mock("../../../lib/job-state-store", () => ({
  readScrapeJobState: vi.fn(async () => null),
}));
vi.mock("../../../lib/job-store-fallback", () => ({
  recordJobStorePostgresFallback: vi.fn(),
}));
vi.mock("../../auth", () => ({
  getACUCTeam: vi.fn(async () => ({ org_id: null })),
}));
vi.mock("../../../lib/request-credits-store", () => ({
  recordRequestCredits: vi.fn(),
}));
vi.mock("../../../lib/keyless", () => ({
  keylessTeamUuid: vi.fn(() => null),
  updateKeylessBrowserCredits: vi.fn(async () => true),
  adjustKeylessCredits: vi.fn(async () => {}),
}));
vi.mock("../../../lib/scrape-interact/langsmith", () => ({
  sanitizeUrlForTrace: (url: string) => url,
}));

vi.mock("../../../lib/supabase-jobs", () => ({
  supabaseGetScrapeByIdDirect: vi.fn(),
}));

vi.mock("../../../lib/browser-sessions", () => ({
  insertBrowserSession: vi.fn(),
  completeBrowserSessionSettlement: vi.fn(async () => {}),
  getBrowserSession: vi.fn(),
  listUnsettledHangarSessions: vi.fn(async () => []),
  updateBrowserSessionActivity: vi.fn(() => Promise.resolve()),
  updateBrowserSessionScrapeId: vi.fn(() => Promise.resolve()),
  settleBrowserSessionOnce: vi.fn(),
  getBrowserSessionFromScrape: vi.fn(),
  markBrowserSessionUsedPrompt: vi.fn(() => Promise.resolve()),
  didBrowserSessionUsePrompt: vi.fn(),
}));

vi.mock("../../../lib/concurrency-limit", () => ({
  getEffectiveConcurrencyLimit: vi.fn(async () => 10),
  getConcurrencyLimitActiveJobsCount: vi.fn(),
  pushConcurrencyLimitActiveJob: vi.fn(() => Promise.resolve()),
  removeConcurrencyLimitActiveJob: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../lib/hangar", () => ({
  createHangarBrowser: vi.fn(),
  executeHangarBrowser: vi.fn(),
  stopHangarBrowser: vi.fn(),
  getHangarRecording: vi.fn(),
  HangarError: class HangarError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("../../../lib/scrape-interact/browser-agent", () => ({
  selectBrowserAgentTab: vi.fn(async () => {}),
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
    checkCredits: vi.fn(async () => ({ allowed: true })),
  },
}));

describe("scrapeInteractController", () => {
  const previousUseDbAuthentication = config.USE_DB_AUTHENTICATION;

  const buildRes = () =>
    ({
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn().mockReturnThis(),
      send: vi.fn(),
    }) as unknown as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBrowserSession).mockResolvedValue(null);
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

    expect(supabaseGetScrapeByIdDirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(501);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error:
        "Scrape interact requires stored scrape context and is not available when database authentication is disabled.",
    });
  });

  it("returns the newly created session's distinct canonical viewer URLs after replay", async () => {
    config.USE_DB_AUTHENTICATION = true;
    const created = {
      id: "br_session",
      status: "running",
      created_at: 100,
      ended_at: null,
      max_expires_at: 700,
      playlist_url: "https://hangar.example/recordings/token/index.m3u8",
      cdp_url: "wss://hangar.example/cdp?token=cdp",
      view_url: "https://hangar.example/live#view",
      control_url: "https://hangar.example/live#control",
      recording: true,
    };
    vi.mocked(supabaseGetScrapeByIdDirect).mockResolvedValue({
      id: "scrape-123",
      team_id: "team-123",
      url: "https://example.com",
      options: {},
    } as any);
    const executed = {
      stdout: "https://example.com",
      result: "",
      stderr: "",
      exitCode: 0,
      killed: false,
    };
    vi.mocked(createHangarBrowser).mockResolvedValue(created as any);
    vi.mocked(executeHangarBrowser).mockResolvedValue(executed);
    vi.mocked(insertBrowserSession).mockImplementation(async row => row as any);
    vi.mocked(executeCodeViaBrowserSession).mockResolvedValue(executed);
    const res = buildRes();
    await scrapeInteractController(
      {
        params: { jobId: "scrape-123" },
        body: { code: "console.log('ok')" },
        headers: {},
        auth: { team_id: "team-123" },
        acuc: {},
      } as any,
      res,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        cdpUrl: created.cdp_url,
        liveViewUrl: created.view_url,
        interactiveLiveViewUrl: created.control_url,
      }),
    );
  });

  it.each([
    browserExecuteController,
    browserDeleteController,
    browserReplayController,
    browserReplayPageController,
  ])(
    "authorizes session ownership before execution, deletion, or returning recording capabilities",
    async controller => {
      vi.mocked(getBrowserSession).mockResolvedValue({
        id: "session",
        browser_id: "br_other",
        team_id: "another-team",
        context_id: "https://hangar.example/recordings/private/index.m3u8",
      } as any);
      const res = buildRes();
      await controller(
        {
          params: { sessionId: "session", pageId: "0" },
          body: { code: "console.log(1)" },
          auth: { team_id: "team-123" },
        } as any,
        res,
      );
      expect(res.status).toHaveBeenCalledWith(403);
      expect(executeHangarBrowser).not.toHaveBeenCalled();
      expect(stopHangarBrowser).not.toHaveBeenCalled();
      expect(getHangarRecording).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Forbidden.",
      });
    },
  );

  it("keeps the replay envelope with one desktop stream after the session stops", async () => {
    const url = "https://hangar.example/recordings/token/index.m3u8";
    vi.mocked(getBrowserSession).mockResolvedValue({
      id: "session",
      team_id: "team-123",
      status: "destroyed",
      context_id: url,
    } as any);
    const res = buildRes();
    vi.mocked(getHangarRecording).mockResolvedValue({
      playlist: "#EXTM3U\n#EXTINF:5,\nhttps://hangar.example/segment.ts\n",
      durationMs: 5000,
    });
    await browserReplayController(
      {
        params: { sessionId: "session" },
        auth: { team_id: "team-123" },
      } as any,
      res,
    );
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      pages: [
        {
          pageId: "0",
          url: "/v2/interact/session/replay/0",
          pageUrl: "",
          startTimeMs: 0,
          endTimeMs: 5000,
        },
      ],
      pageCount: 1,
    });
    const pageRes = buildRes();
    await browserReplayPageController(
      {
        params: { sessionId: "session", pageId: "0" },
        auth: { team_id: "team-123" },
      } as any,
      pageRes,
    );
    expect(pageRes.status).toHaveBeenCalledWith(200);
    expect(pageRes.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/vnd.apple.mpegurl",
    );
    expect(pageRes.send).toHaveBeenCalledWith(
      expect.stringContaining("#EXTM3U"),
    );
  });

  it.each([
    ["invalid", 400],
    ["1", 404],
  ])("rejects unavailable replay page %s", async (pageId, status) => {
    vi.mocked(getBrowserSession).mockResolvedValue({
      id: "session",
      team_id: "team-123",
      context_id: "https://hangar.example/playlist",
    } as any);
    const res = buildRes();
    await browserReplayPageController(
      {
        params: { sessionId: "session", pageId },
        auth: { team_id: "team-123" },
      } as any,
      res,
    );
    expect(res.status).toHaveBeenCalledWith(status);
    expect(getHangarRecording).not.toHaveBeenCalled();
  });
});

vi.mock("../../../services/redlock", () => ({ redlock: { using: vi.fn() } }));
