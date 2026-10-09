import type { Response } from "express";
import { readScrapeJobState } from "../../../lib/job-state-store";
import { vi } from "vitest";
import { config } from "../../../config";
import {
  insertBrowserSession,
  getBrowserSession,
  listUnsettledHangarSessions,
  settleBrowserSessionOnce,
  withLockedBrowserSession,
  didBrowserSessionUsePrompt,
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
import { browserCreateController } from "../browser";
import {
  getBrowserZDR,
  BrowserSessionError,
  reconcileBrowserSessions,
  settleBrowserSession,
  reserveBrowserPromptCredits,
} from "../../../lib/browser-lifecycle";
import { logRequest } from "../../../services/logging/log_job";
import { getModel } from "../../../lib/generic-ai";
import { generateText } from "ai";
import * as langsmith from "../../../lib/scrape-interact/langsmith";
import { promises as fs } from "fs";
import { logger } from "../../../lib/logger";
import { context, propagation, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { isZeroDataRetentionActive } from "../../../lib/otel-tracer";
import { scrapeQueue } from "../../../services/worker/nuq-router";
import { redlock } from "../../../services/redlock";
import { updateKeylessBrowserCredits } from "../../../lib/keyless";

vi.mock("../../../lib/generic-ai", () => ({ getModel: vi.fn(() => ({})) }));
vi.mock("../../../services/rate-limiter", () => ({
  redisRateLimitClient: {
    get: vi.fn(async () => null),
    set: vi.fn(),
    hgetall: vi.fn(async () => ({})),
    hset: vi.fn(),
    expire: vi.fn(),
    del: vi.fn(),
  },
}));
vi.mock("ai", async importOriginal => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: vi.fn(async () => ({ text: "done" })),
}));

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
  buildLangSmithProviderOptions: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("../../../lib/browser-sessions", () => ({
  insertBrowserSession: vi.fn(),
  completeBrowserSessionSettlement: vi.fn(async () => {}),
  getBrowserSession: vi.fn(),
  listUnsettledHangarSessions: vi.fn(async () => []),
  updateBrowserSessionActivity: vi.fn(() => Promise.resolve()),
  updateBrowserSessionScrapeId: vi.fn(() => Promise.resolve()),
  settleBrowserSessionOnce: vi.fn(),
  withLockedBrowserSession: vi.fn(),
  getBrowserSessionFromScrape: vi.fn(),
  markBrowserSessionUsedPrompt: vi.fn(() => Promise.resolve()),
  didBrowserSessionUsePrompt: vi.fn(),
}));

vi.mock("../../../lib/concurrency-limit", () => ({
  getConcurrencyLimitActiveJobsCount: vi.fn(),
  pushConcurrencyLimitActiveJob: vi.fn(() => Promise.resolve()),
  removeConcurrencyLimitActiveJob: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../lib/hangar", () => ({
  createHangarBrowser: vi.fn(),
  executeHangarBrowser: vi.fn(),
  stopHangarBrowser: vi.fn(),
  getHangarRecording: vi.fn(),
  getHangarBrowser: vi.fn(async () => ({ status: "running" })),
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
  DEFAULT_TEAM_LIMITS: { concurrency_limit: 2, rate_limit_multiplier: 1 },
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

  describe("ZDR", () => {
    const provider = new NodeTracerProvider();
    beforeAll(() => provider.register());
    afterAll(async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    });
    const buildRequest = () =>
      ({
        body: { zeroDataRetention: true },
        headers: {},
        auth: { team_id: "team-123" },
        acuc: { flags: { scrapeZDR: "allowed" } },
      }) as any;

    const session = {
      id: "session-123",
      team_id: "team-123",
      browser_id: "br_zdr",
      status: "active",
      zero_data_retention: true,
    } as any;
    const output = {
      stdout: "claim-private",
      result: "",
      stderr: "",
      exitCode: 0,
      killed: false,
    };

    beforeEach(() => {
      vi.mocked(createHangarBrowser).mockResolvedValue({
        id: session.browser_id,
        max_expires_at: 700,
        cdp_url: "wss://hangar.example/cdp?token=secret",
        view_url: "https://hangar.example/view?token=secret",
        control_url: "https://hangar.example/control?token=secret",
      } as any);
      vi.mocked(insertBrowserSession).mockImplementation(
        async row => row as any,
      );
      vi.mocked(getBrowserSession).mockResolvedValue(session);
      vi.mocked(executeHangarBrowser).mockResolvedValue(output);
    });

    it.each(["allowed", "forced"] as const)(
      "persists ZDR and redacts request logging when the team policy is %s",
      async mode => {
        const req = buildRequest();
        req.acuc.flags.scrapeZDR = mode;
        if (mode === "forced") req.body = {};
        const privateContent = "private-claim-sentinel";
        req.body.url = `https://claims.example/${privateContent}`;
        req.body.prompt = privateContent;
        const res = buildRes();
        await browserCreateController(req, res);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ success: true }),
        );
        expect(insertBrowserSession).toHaveBeenCalledWith(
          expect.objectContaining({ zero_data_retention: true }),
        );
        expect(logRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            zeroDataRetention: true,
            target_hint: "Browser session",
          }),
        );
        expect(JSON.stringify(vi.mocked(logRequest).mock.calls)).not.toContain(
          privateContent,
        );
        expect(createHangarBrowser).toHaveBeenCalledWith(
          expect.any(String),
          "team-123",
          expect.objectContaining({ recordSession: false }),
        );
      },
    );

    it("stores and returns access URLs for active ZDR sessions", async () => {
      const res = buildRes();
      await browserCreateController(buildRequest(), res);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          cdpUrl: "wss://hangar.example/cdp?token=secret",
          liveViewUrl: "https://hangar.example/view?token=secret",
          interactiveLiveViewUrl: "https://hangar.example/control?token=secret",
        }),
      );
      expect(insertBrowserSession).toHaveBeenCalledWith(
        expect.objectContaining({
          context_id: "",
          cdp_url: "wss://hangar.example/cdp?token=secret",
          cdp_path: "https://hangar.example/view?token=secret",
          cdp_interactive_path: "https://hangar.example/control?token=secret",
        }),
      );
    });

    it("reserves the ZDR code-only rate at create", async () => {
      await browserCreateController(buildRequest(), buildRes());
      // 600s default TTL at 240/hr
      expect(updateKeylessBrowserCredits).toHaveBeenCalledWith(
        "team-123",
        "session-123",
        40,
      );
    });

    it("reserves the ZDR prompt rate on the first prompt", async () => {
      const row = {
        ...session,
        should_bill: true,
        ttl_total: 600,
        credits_used: null,
      };
      vi.mocked(didBrowserSessionUsePrompt)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      vi.mocked(withLockedBrowserSession).mockImplementationOnce(
        async (_id, fn) => fn(row, undefined as any),
      );
      await reserveBrowserPromptCredits(buildRequest(), row);
      // 600s TTL at 540/hr
      expect(updateKeylessBrowserCredits).toHaveBeenCalledWith(
        "team-123",
        "session-123",
        90,
      );
    });

    it.each([
      [false, 20],
      [true, 45],
    ])(
      "settles a 5 minute ZDR session (usedPrompt=%s) at %i credits",
      async (usedPrompt, expected) => {
        const row = { ...session, should_bill: true };
        vi.mocked(didBrowserSessionUsePrompt).mockResolvedValueOnce(usedPrompt);
        vi.mocked(settleBrowserSessionOnce).mockImplementationOnce(
          async (_id, bill) => ({
            creditsBilled: await bill(row),
            newlySettled: false,
          }),
        );
        const result = await settleBrowserSession(row, {
          status: "stopped",
          created_at: 0,
          ended_at: 300,
        } as any);
        expect(result?.creditsBilled).toBe(expected);
      },
    );

    it("keeps the session's ZDR policy when later execution omits the option and team flag", async () => {
      const req = {
        ...buildRequest(),
        acuc: {},
        params: { sessionId: session.id },
        body: { code: "console.log('claim-private')" },
      };
      expect(getBrowserZDR(req, session)).toBe(true);
      const res = buildRes();
      await browserExecuteController(req, res);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ stdout: "claim-private" }),
      );
    });

    it("continues a ZDR scrape using a live session without saved replay context", async () => {
      vi.mocked(scrapeQueue.getJob).mockImplementationOnce(async () => {
        expect(isZeroDataRetentionActive()).toBe(true);
        return null;
      });
      vi.mocked(readScrapeJobState).mockImplementationOnce(async () => {
        expect(isZeroDataRetentionActive()).toBe(true);
        return {
          status: "completed",
          requestId: "scrape-123",
          completedAtMs: Date.now(),
          creditsBilled: 1,
          zeroDataRetention: true,
        };
      });
      vi.mocked(executeCodeViaBrowserSession).mockResolvedValue(output);
      const res = buildRes();
      await scrapeInteractController(
        {
          ...buildRequest(),
          acuc: {},
          params: { jobId: "scrape-123" },
          body: {
            code: "console.log('claim-private')",
            existingSessionId: session.id,
          },
        },
        res,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(executeCodeViaBrowserSession).toHaveBeenCalledWith(
        session.browser_id,
        expect.anything(),
        expect.objectContaining({ zeroDataRetention: true }),
      );
      expect(createHangarBrowser).not.toHaveBeenCalled();
    });

    it("preserves ZDR when reconciliation retries an already billed session", async () => {
      let retentionDuringFinalization: boolean | undefined;
      vi.mocked(redlock.using).mockImplementationOnce((async (...args: any[]) =>
        args.at(-1)({ aborted: false })) as any);
      vi.mocked(listUnsettledHangarSessions).mockResolvedValueOnce({
        sessions: [{ ...session, credits_used: 2 }],
        through: session.id,
      });
      vi.mocked(updateKeylessBrowserCredits).mockImplementationOnce(
        async () => {
          retentionDuringFinalization = isZeroDataRetentionActive();
          return true;
        },
      );
      await reconcileBrowserSessions();
      expect(updateKeylessBrowserCredits).toHaveBeenCalledWith(
        session.team_id,
        session.id,
        2,
        true,
      );
      expect(retentionDuringFinalization).toBe(true);
    });

    async function runPrompt() {
      const agent = await vi.importActual<
        typeof import("../../../lib/scrape-interact/browser-agent")
      >("../../../lib/scrape-interact/browser-agent");
      vi.mocked(executeHangarBrowser).mockResolvedValue({
        ...output,
        stdout: "a".repeat(32),
      });
      const result = await agent.executePromptViaBrowserAgent(
        "claim-private",
        session.browser_id,
        30,
        logger,
        {
          sessionId: session.id,
          scrapeId: "scrape-123",
          teamId: "team-123",
          zeroDataRetention: true,
        },
      );
      expect(result.output).toBe("done");
    }

    it("uses Luna medium without response storage or AI telemetry for ZDR prompts", async () => {
      await runPrompt();
      expect(getModel).toHaveBeenCalledWith("gpt-6-luna", "openai", {
        ignoreModelOverride: true,
      });
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: {
            openai: {
              store: false,
              reasoningEffort: "medium",
            },
          },
          temperature: undefined,
          experimental_telemetry: { isEnabled: false },
        }),
      );
    });

    it("bypasses the LangSmith-wrapped SDK for ZDR prompts", async () => {
      await runPrompt();
      expect(generateText).toHaveBeenCalled();
      expect(langsmith.generateText).not.toHaveBeenCalled();
    });

    it("does not write local debug logs for ZDR prompts", async () => {
      const append = vi.spyOn(fs, "appendFile");
      try {
        await runPrompt();
        expect(append).not.toHaveBeenCalled();
      } finally {
        append.mockRestore();
      }
    });

    it.each([
      ["recording", { recordSession: true }],
      ["saved profiles", { profile: { name: "claims" } }],
    ])("rejects %s before creating a ZDR browser", async (_, forbidden) => {
      const req = buildRequest();
      req.body = { zeroDataRetention: true, ...(forbidden as object) };
      const res = buildRes();
      await browserCreateController(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(createHangarBrowser).not.toHaveBeenCalled();
    });

    it("rejects request-scoped ZDR without the entitlement", async () => {
      const res = buildRes();
      const req = { ...buildRequest(), acuc: {} };
      expect(() => getBrowserZDR(req)).toThrow(BrowserSessionError);
      await browserCreateController(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Zero Data Retention is not enabled for your team.",
      });
      expect(createHangarBrowser).not.toHaveBeenCalled();
    });

    it("rejects upgrading a retained session to ZDR during execution", async () => {
      vi.mocked(getBrowserSession).mockResolvedValue({
        ...session,
        zero_data_retention: false,
      });
      const req = buildRequest();
      req.params = { sessionId: session.id };
      req.body = {
        zeroDataRetention: true,
        code: "console.log('claim-private')",
      };
      const res = buildRes();
      await browserExecuteController(req, res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(executeHangarBrowser).not.toHaveBeenCalled();
    });
  });

  it("rejects scrape interact when database authentication is disabled", async () => {
    config.USE_DB_AUTHENTICATION = false;

    const req = {
      params: { jobId: "scrape-123" },
      body: { prompt: "click the first result" },
      auth: { team_id: "team-123" },
      acuc: {},
    } as RequestWithAuth<{ jobId: string }, any, any>;
    const res = buildRes();

    await scrapeInteractController(req, res);

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
    // The replay context comes from the scrape's Bigtable terminal state.
    vi.mocked(readScrapeJobState).mockResolvedValueOnce({
      status: "completed",
      requestId: "scrape-123",
      completedAtMs: Date.now(),
      creditsBilled: 1,
      replay: { targetUrl: "https://example.com", waitForMs: 0, actions: [] },
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
    expect(insertBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cdp_url: created.cdp_url,
        cdp_path: created.view_url,
        cdp_interactive_path: created.control_url,
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
