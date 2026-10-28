vi.mock("../../../lib/crawl-regex", async () => {
  const { z } = await import("zod");
  return {
    addPathRegexIssues: vi.fn(),
    pathPatternsSchema: z.array(z.string()),
  };
});
import { agentController } from "../agent";
import { logRequest } from "../../../services/logging/log_job";
import { logger } from "../../../lib/logger";
import { emitRejectedScrapeActivityEvents } from "../../../lib/siem-logging";
import {
  checkUrlsAgainstThreatPolicy,
  resolveThreatProtection,
} from "../../../lib/threat-protection/request";
import { fetchAgentThread } from "../agent-thread";
vi.mock("../../../lib/logger", () => {
  const logger = { info: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return { logger };
});
vi.mock("../../../services/logging/log_job", () => ({ logRequest: vi.fn() }));
vi.mock("../../../lib/external-request-id", () => ({
  externalRequestId: () => undefined,
}));
vi.mock("../../../config", () => ({
  config: {
    EXTRACT_V3_BETA_URL: "https://agent.example",
    USE_DB_AUTHENTICATION: false,
    AGENT_INTEROP_SECRET: "test",
  },
}));
vi.mock("../../../db/rpc", () => ({ agentConsumeFreeRequestIfLeft: vi.fn() }));
vi.mock("../../../services/autumn/autumn.service", () => ({
  autumnService: { checkCredits: vi.fn(), hasAutoTopUp: vi.fn() },
}));
vi.mock("../../../lib/threat-protection/request", () => ({
  resolveThreatProtection: vi.fn().mockResolvedValue({}),
  checkUrlsAgainstThreatPolicy: vi.fn(),
}));
vi.mock("../../../lib/scrape-billing", () => ({
  calculateThreatScanCredits: vi.fn(),
}));
vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn(),
}));
vi.mock("../../../lib/siem-logging", () => ({
  emitRejectedScrapeActivityEvents: vi.fn(),
}));
vi.mock("../agent-thread", () => ({
  fetchAgentThread: vi.fn(),
  threadErrorFor: vi.fn(),
}));

function run(body: Record<string, unknown>, flags: Record<string, unknown>) {
  const req = {
    body: { prompt: "Find the price", ...body },
    auth: { team_id: "team-test" },
    acuc: { flags, api_key: "test-key" },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return agentController(req as any, res as any).then(() => res);
}

function forwardedBody() {
  return JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
}

describe("agentController zero data retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [
      "forced (scrapeZDR)",
      {},
      { scrapeZDR: "forced", searchZDR: "forced-zdr" },
    ],
    ["forced (legacy forceZDR)", {}, { forceZDR: true }],
    [
      "forced with an explicit opt-out",
      { zeroDataRetention: false },
      { scrapeZDR: "forced", searchZDR: "allowed" },
    ],
    [
      "allowed with opt-in",
      { zeroDataRetention: true },
      { scrapeZDR: "allowed", searchZDR: "allowed" },
    ],
  ])("runs with ZDR when %s", async (_name, body, flags) => {
    const res = await run(body, flags);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(forwardedBody().zeroDataRetention).toBe(true);
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent", zeroDataRetention: true }),
    );
    expect(logger.child).toHaveBeenCalledWith(
      expect.objectContaining({ zeroDataRetention: true }),
    );
  });

  it.each([
    ["allowed without opt-in", {}, { scrapeZDR: "allowed" }],
    ["disabled without opt-in", {}, {}],
  ])("runs without ZDR when %s", async (_name, body, flags) => {
    const res = await run(body, flags);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(forwardedBody()).not.toHaveProperty("zeroDataRetention");
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ zeroDataRetention: false }),
    );
  });

  it.each([
    ["opt-in, neither enabled", { zeroDataRetention: true }, {}],
    [
      "opt-in, scrape ZDR only",
      { zeroDataRetention: true },
      { scrapeZDR: "allowed" },
    ],
    [
      "opt-in, search ZDR only",
      { zeroDataRetention: true },
      { searchZDR: "allowed" },
    ],
    ["scrape ZDR forced, no search ZDR", {}, { scrapeZDR: "forced" }],
    [
      "scrape ZDR forced, search anonymous only",
      {},
      { scrapeZDR: "forced", searchZDR: "forced-anon" },
    ],
  ])("rejects a ZDR run up front when %s", async (_name, body, flags) => {
    const res = await run(body, flags);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "zdr_not_enabled",
      error:
        "Zero Data Retention (ZDR) for agent runs requires both scrape ZDR and search ZDR to be enabled for your team. Contact support@firecrawl.com to enable it.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(logRequest).not.toHaveBeenCalled();
  });

  const zdrFlags = { scrapeZDR: "forced", searchZDR: "forced-zdr" };

  it("forwards the team's ZDR retention tier", async () => {
    const res = await run({}, { ...zdrFlags, agentZdrRetentionMinutes: 30 });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(forwardedBody()).toMatchObject({
      zeroDataRetention: true,
      zeroDataRetentionMinutes: 30,
    });
  });

  it("leaves the retention to the agent service's default when the flag is unset", async () => {
    await run({}, zdrFlags);

    expect(forwardedBody()).not.toHaveProperty("zeroDataRetentionMinutes");
  });

  it("does not forward a retention for a run without ZDR", async () => {
    await run({}, { agentZdrRetentionMinutes: 30 });

    expect(forwardedBody()).not.toHaveProperty("zeroDataRetentionMinutes");
  });

  it("refuses a ZDR run whose retention flag is not a tier, rather than keep it longer", async () => {
    const res = await run({}, { ...zdrFlags, agentZdrRetentionMinutes: 45 });

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "zdr_retention_misconfigured" }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a run that does not ask for ZDR alone, whatever the search flag", async () => {
    const res = await run({}, { scrapeZDR: "allowed" });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(forwardedBody()).not.toHaveProperty("zeroDataRetention");
  });

  it("rejects a thread follow-up under ZDR", async () => {
    const res = await run(
      { threadId: "0190e3c8-4b2a-7c3d-8e9f-0a1b2c3d4e5f" },
      { scrapeZDR: "forced", searchZDR: "allowed" },
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "zdr_threads_unsupported",
      }),
    );
    expect(fetchAgentThread).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(logRequest).not.toHaveBeenCalled();
  });

  it.each([
    [
      "opted in",
      { zeroDataRetention: true },
      { scrapeZDR: "allowed", searchZDR: "allowed" },
    ],
    ["forced", {}, { scrapeZDR: "forced", searchZDR: "forced-zdr" }],
  ])(
    "forwards exchange options with the ZDR flag when %s",
    async (_name, body, flags) => {
      const exchange = { enabled: true, toolkits: ["fred"], maxCalls: 4 };
      const res = await run({ ...body, exchange }, flags);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(forwardedBody()).toMatchObject({
        exchange,
        zeroDataRetention: true,
      });
      expect(logRequest).toHaveBeenCalledWith(
        expect.objectContaining({ zeroDataRetention: true }),
      );
    },
  );

  it("rejects a thread follow-up under ZDR even when it asks for exchange", async () => {
    const res = await run(
      {
        zeroDataRetention: true,
        threadId: "0190e3c8-4b2a-7c3d-8e9f-0a1b2c3d4e5f",
        exchange: { enabled: true },
      },
      { scrapeZDR: "allowed", searchZDR: "allowed" },
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "zdr_threads_unsupported",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["the team's tier", { agentZdrRetentionMinutes: 15 }, 15],
    ["24 hours when the flag is unset", {}, 24 * 60],
  ])(
    "records %s on the job access row",
    async (_name, retentionFlags, minutes) => {
      const res = await run(
        {},
        { scrapeZDR: "forced", searchZDR: "forced-zdr", ...retentionFlags },
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(logRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          zeroDataRetention: true,
          jobAccessZeroDataRetentionMinutes: minutes,
        }),
      );
    },
  );

  it("records no retention for a run without ZDR", async () => {
    await run({}, { agentZdrRetentionMinutes: 15 });

    expect(vi.mocked(logRequest).mock.calls[0][0]).not.toHaveProperty(
      "jobAccessZeroDataRetentionMinutes",
    );
  });

  it("forwards exchange options unchanged without ZDR", async () => {
    const exchange = { enabled: true };
    const res = await run({ exchange }, {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(forwardedBody().exchange).toEqual(exchange);
    expect(forwardedBody()).not.toHaveProperty("zeroDataRetention");
  });

  it("marks rejected threat events as ZDR", async () => {
    vi.mocked(resolveThreatProtection).mockResolvedValueOnce({
      policy: {},
    } as any);
    vi.mocked(checkUrlsAgainstThreatPolicy).mockResolvedValueOnce({
      blocked: [{ url: "https://blocked.example", decision: {} }],
      decisionsByUrl: new Map(),
    } as any);

    const res = await run(
      { urls: ["https://blocked.example"] },
      { scrapeZDR: "forced", searchZDR: "allowed" },
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(emitRejectedScrapeActivityEvents).toHaveBeenCalledWith([
      expect.objectContaining({ zeroDataRetention: true }),
    ]);
  });
});
