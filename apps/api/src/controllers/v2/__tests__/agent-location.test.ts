vi.mock("../../../lib/crawl-regex", async () => {
  const { z } = await import("zod");
  return {
    addPathRegexIssues: vi.fn(),
    pathPatternsSchema: z.array(z.string()),
  };
});
import { agentController } from "../agent";
import { agentRequestSchema } from "../types";
vi.mock("../../../lib/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
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

describe("agentRequestSchema location", () => {
  const base = { prompt: "Find the pricing page" };

  it.each(["DE", "de", "Gb"])("accepts %s and lowercases it", country => {
    const parsed = agentRequestSchema.parse({ ...base, location: { country } });

    expect(parsed.location).toEqual({ country: country.toLowerCase() });
  });

  it("leaves location undefined when omitted", () => {
    const parsed = agentRequestSchema.parse(base);

    expect(parsed.location).toBeUndefined();
  });

  it.each(["XX", "us-whitelist", "us-generic", "", "DEU"])(
    "rejects country %j",
    country => {
      expect(() =>
        agentRequestSchema.parse({ ...base, location: { country } }),
      ).toThrow();
    },
  );

  it("rejects a location without a country", () => {
    expect(() => agentRequestSchema.parse({ ...base, location: {} })).toThrow();
  });

  it("rejects fields other than country", () => {
    expect(() =>
      agentRequestSchema.parse({
        ...base,
        location: { country: "DE", languages: ["de"] },
      }),
    ).toThrow();
  });
});

describe("agentController location passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const run = async (body: Record<string, unknown>) => {
    const req = {
      body,
      auth: { team_id: "team-test" },
      acuc: { flags: {}, api_key: "test-key" },
    };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await agentController(req as any, res as any);
    expect(res.status).toHaveBeenCalledWith(200);
    return JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  };

  it("forwards the lowercased country to the agent service", async () => {
    const body = await run({
      prompt: "Find the pricing page",
      location: { country: "DE" },
    });

    expect(body.location).toEqual({ country: "de" });
  });

  it("sends no location key when the caller omits it", async () => {
    const body = await run({ prompt: "Find the pricing page" });

    expect(body).not.toHaveProperty("location");
  });
});
