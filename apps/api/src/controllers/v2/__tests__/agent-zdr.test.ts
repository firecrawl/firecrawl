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
    ["forced (scrapeZDR)", {}, { scrapeZDR: "forced" }],
    ["forced (legacy forceZDR)", {}, { forceZDR: true }],
    [
      "forced with an explicit opt-out",
      { zeroDataRetention: false },
      { scrapeZDR: "forced" },
    ],
    [
      "allowed with opt-in",
      { zeroDataRetention: true },
      { scrapeZDR: "allowed" },
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

  it("rejects an opt-in from a team without the entitlement", async () => {
    const res = await run({ zeroDataRetention: true }, {});

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error:
        "Zero Data Retention (ZDR) is not enabled for your team. Contact support@firecrawl.com to enable this feature.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(logRequest).not.toHaveBeenCalled();
  });

  it("rejects a thread follow-up under ZDR", async () => {
    const res = await run(
      { threadId: "0190e3c8-4b2a-7c3d-8e9f-0a1b2c3d4e5f" },
      { scrapeZDR: "forced" },
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

  it("rejects exchange options under ZDR", async () => {
    const res = await run(
      { zeroDataRetention: true, exchange: { enabled: true } },
      { scrapeZDR: "allowed" },
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "zdr_exchange_unsupported",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(logRequest).not.toHaveBeenCalled();
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
      { scrapeZDR: "forced" },
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(emitRejectedScrapeActivityEvents).toHaveBeenCalledWith([
      expect.objectContaining({ zeroDataRetention: true }),
    ]);
  });
});
