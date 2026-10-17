import type { Response } from "express";
import { readScrapeJobState } from "../../../lib/job-state-store";
import { vi } from "vitest";
import { config } from "../../../config";
import {
  abandonBrowserSession,
  getBrowserSessionFromScrape,
  updateBrowserSessionScrapeId,
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

const lockState = vi.hoisted(() => ({
  chains: new Map<string, Promise<void>>(),
  controllers: new Map<string, AbortController>(),
}));

vi.mock("uuid", () => ({
  v7: vi.fn(() => "session-123"),
}));

vi.mock("../../../config", () => ({
  config: {
    USE_DB_AUTHENTICATION: true,
    HANGAR_URL: "http://localhost:9000",
    REDIS_RATE_LIMIT_URL: process.env.REDIS_RATE_LIMIT_URL,
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
  abandonBrowserSession: vi.fn(),
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
    lockState.chains.clear();
    lockState.controllers.clear();
    vi.mocked(getBrowserSessionFromScrape).mockResolvedValue(null);
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

    describe("locked scrape initialization", () => {
      let stored: any;
      const request = () =>
        ({
          params: { jobId: "scrape-123" },
          body: { code: "console.log('private')" },
          headers: {},
          auth: { team_id: "team-123" },
          acuc: { flags: { scrapeZDR: "allowed" } },
        }) as any;
      const expire = () =>
        lockState.controllers
          .get("browser:scrape:scrape-123:create")!
          .abort(new Error("creation lease lost"));
      beforeEach(() => {
        stored = null;
        vi.mocked(readScrapeJobState).mockResolvedValue({
          status: "completed",
          zeroDataRetention: true,
          replay: {
            targetUrl: "https://private.example",
            waitForMs: 0,
            actions: [],
          },
        } as any);
        vi.mocked(getBrowserSessionFromScrape).mockImplementation(
          async scrapeId => {
            expect(isZeroDataRetentionActive()).toBe(true);
            return stored?.scrape_id === scrapeId ? stored : null;
          },
        );
        vi.mocked(insertBrowserSession).mockImplementation(async row => {
          expect(row.scrape_id).toBeNull();
          expect(row.zero_data_retention).toBe(true);
          expect(isZeroDataRetentionActive()).toBe(true);
          stored = row;
          return row as any;
        });
        // A lookup abort leaves a queued link implementation unused. Clear
        // that queue so subsequent lease phases exercise their own fixture.
        vi.mocked(updateBrowserSessionScrapeId).mockReset();
        vi.mocked(updateBrowserSessionScrapeId).mockImplementation(
          async (id, scrapeId) => {
            expect(isZeroDataRetentionActive()).toBe(true);
            expect(id).toBe(stored.id);
            stored = { ...stored, scrape_id: scrapeId };
          },
        );
        vi.mocked(abandonBrowserSession).mockImplementation(async id => {
          expect(isZeroDataRetentionActive()).toBe(true);
          expect(id).toBe(stored.id);
          stored = { ...stored, should_bill: false, scrape_id: null };
          return stored;
        });
        vi.mocked(executeCodeViaBrowserSession).mockImplementation(async () => {
          expect(isZeroDataRetentionActive()).toBe(true);
          return output;
        });
        vi.mocked(stopHangarBrowser).mockResolvedValue({
          status: "stopped",
          created_at: 100,
          ended_at: 100,
        } as any);
      });
      afterEach(() => {
        vi.mocked(readScrapeJobState).mockResolvedValue(null);
        vi.mocked(getBrowserSessionFromScrape).mockResolvedValue(null);
        vi.mocked(updateBrowserSessionScrapeId)
          .mockReset()
          .mockResolvedValue(undefined);
        vi.mocked(insertBrowserSession).mockImplementation(
          async row => row as any,
        );
        vi.mocked(executeCodeViaBrowserSession).mockReset();
        vi.mocked(stopHangarBrowser).mockReset();
      });
      it("publishes only one initialized private browser for concurrent first interactions", async () => {
        const responses = [buildRes(), buildRes()];
        await Promise.all(
          responses.map(res => scrapeInteractController(request(), res)),
        );
        expect(createHangarBrowser).toHaveBeenCalledTimes(1);
        expect(insertBrowserSession).toHaveBeenCalledTimes(1);
        expect(updateBrowserSessionScrapeId).toHaveBeenCalledTimes(1);
        expect(redlock.using).toHaveBeenCalledTimes(2);
        expect(executeCodeViaBrowserSession).toHaveBeenCalledTimes(2);
        for (const res of responses)
          expect(res.status).toHaveBeenCalledWith(200);
        expect(stored.scrape_id).toBe("scrape-123");
      });
      it("serializes concurrent creation through the actual harness Redis lease", async () => {
        expect(process.env.REDIS_RATE_LIMIT_URL).toBeTruthy();
        const actual = await vi.importActual<
          typeof import("../../../services/redlock")
        >("../../../services/redlock");
        try {
          vi.mocked(redlock.using).mockImplementationOnce(
            actual.redlock.using.bind(actual.redlock),
          );
          vi.mocked(redlock.using).mockImplementationOnce(
            actual.redlock.using.bind(actual.redlock),
          );
          const responses = [buildRes(), buildRes()];
          await Promise.all(
            responses.map(res => scrapeInteractController(request(), res)),
          );
          expect(createHangarBrowser).toHaveBeenCalledTimes(1);
          expect(updateBrowserSessionScrapeId).toHaveBeenCalledTimes(1);
          expect(executeCodeViaBrowserSession).toHaveBeenCalledTimes(2);
          for (const res of responses)
            expect(res.status).toHaveBeenCalledWith(200);
        } finally {
          await Promise.all(
            [...actual.redlock.clients].map(client => client.quit()),
          );
        }
      });
      it.each(["lookup", "link", "healthy"] as const)(
        "checks the adopted private browser lease during %s",
        async phase => {
          const existing = { ...session, should_bill: true, scrape_id: null };
          const req = request();
          req.body.existingSessionId = existing.id;
          vi.mocked(getBrowserSession).mockImplementationOnce(async () => {
            expect(isZeroDataRetentionActive()).toBe(true);
            if (phase === "lookup") expire();
            return existing;
          });
          vi.mocked(updateBrowserSessionScrapeId).mockImplementationOnce(
            async () => {
              expect(isZeroDataRetentionActive()).toBe(true);
              if (phase === "link") expire();
            },
          );
          const res = buildRes();
          await scrapeInteractController(req, res);
          expect(res.status).toHaveBeenCalledWith(
            phase === "healthy" ? 200 : 503,
          );
          expect(executeCodeViaBrowserSession).toHaveBeenCalledTimes(
            phase === "healthy" ? 1 : 0,
          );
          expect(updateBrowserSessionScrapeId).toHaveBeenCalledTimes(
            phase === "lookup" ? 0 : 1,
          );
          expect(createHangarBrowser).not.toHaveBeenCalled();
          expect(abandonBrowserSession).not.toHaveBeenCalled();
          expect(stopHangarBrowser).not.toHaveBeenCalled();
        },
      );
      it.each(["lease", "link", "link-lease"] as const)(
        "abandons an unexposed private browser after %s failure",
        async phase => {
          if (phase === "lease")
            vi.mocked(executeHangarBrowser).mockImplementationOnce(async () => {
              expire();
              return output;
            });
          else if (phase === "link")
            vi.mocked(updateBrowserSessionScrapeId).mockRejectedValueOnce(
              new Error("link failed"),
            );
          else
            vi.mocked(updateBrowserSessionScrapeId).mockImplementationOnce(
              async (_id, scrapeId) => {
                stored = { ...stored, scrape_id: scrapeId };
                expire();
              },
            );
          const res = buildRes();
          await scrapeInteractController(request(), res);
          expect(res.status).toHaveBeenCalledWith(503);
          expect(abandonBrowserSession).toHaveBeenCalledWith(stored.id);
          expect(stored).toMatchObject({
            scrape_id: null,
            should_bill: false,
            zero_data_retention: true,
          });
          expect(executeCodeViaBrowserSession).not.toHaveBeenCalled();
          expect(stopHangarBrowser).toHaveBeenCalled();
        },
      );
      it("fails without creating a browser when the shared creation lease is unavailable", async () => {
        vi.mocked(redlock.using).mockRejectedValueOnce(
          new Error("lease unavailable"),
        );
        const res = buildRes();
        await scrapeInteractController(request(), res);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(createHangarBrowser).not.toHaveBeenCalled();
        expect(insertBrowserSession).not.toHaveBeenCalled();
        expect(executeCodeViaBrowserSession).not.toHaveBeenCalled();
      });
      it("uses independent leases for different scrape jobs", async () => {
        const rows = new Map<string, any>();
        const uuid = await vi.importMock<typeof import("uuid")>("uuid");
        vi.mocked(uuid.v7 as () => string)
          .mockReturnValueOnce("session-one")
          .mockReturnValueOnce("session-two");
        vi.mocked(getBrowserSessionFromScrape).mockImplementation(
          async scrapeId =>
            [...rows.values()].find(row => row.scrape_id === scrapeId) ?? null,
        );
        vi.mocked(insertBrowserSession).mockImplementation(async row => {
          rows.set(row.id, row);
          return row as any;
        });
        vi.mocked(updateBrowserSessionScrapeId).mockImplementation(
          async (id, scrapeId) => {
            rows.set(id, { ...rows.get(id), scrape_id: scrapeId });
          },
        );
        const requests = [request(), request()];
        requests[1].params.jobId = "scrape-other";
        const responses = [buildRes(), buildRes()];
        await Promise.all(
          requests.map((req, index) =>
            scrapeInteractController(req, responses[index]),
          ),
        );
        expect(
          vi.mocked(redlock.using).mock.calls.map(([keys]) => keys),
        ).toEqual([
          ["browser:scrape:scrape-123:create"],
          ["browser:scrape:scrape-other:create"],
        ]);
        expect(createHangarBrowser).toHaveBeenCalledTimes(2);
        for (const res of responses)
          expect(res.status).toHaveBeenCalledWith(200);
        expect([...rows.values()].map(row => row.scrape_id).sort()).toEqual([
          "scrape-123",
          "scrape-other",
        ]);
      });
      it("preserves the privacy rejection when adopting a retained browser for a private scrape", async () => {
        vi.mocked(getBrowserSession).mockResolvedValueOnce({
          ...session,
          zero_data_retention: false,
        });
        const req = request();
        req.body.existingSessionId = session.id;
        const res = buildRes();
        await scrapeInteractController(req, res);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(updateBrowserSessionScrapeId).not.toHaveBeenCalled();
        expect(executeCodeViaBrowserSession).not.toHaveBeenCalled();
        expect(abandonBrowserSession).not.toHaveBeenCalled();
      });
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

// A controllable lease double protects controller state boundaries; native
// Redis acquisition itself remains the harness's responsibility.
vi.mock("../../../services/redlock", () => ({
  redlock: {
    using: vi.fn(async (keys: string[], _ttl: number, ...args: any[]) => {
      const key = [...keys].sort().join("|");
      const previous = lockState.chains.get(key) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      lockState.chains.set(key, held);
      await previous;
      const controller = new AbortController();
      Object.defineProperty(controller.signal, "error", {
        get: () => controller.signal.reason,
      });
      lockState.controllers.set(key, controller);
      try {
        return await args.at(-1)(controller.signal);
      } finally {
        release();
        if (lockState.chains.get(key) === held) lockState.chains.delete(key);
        if (lockState.controllers.get(key) === controller)
          lockState.controllers.delete(key);
      }
    }),
  },
}));
