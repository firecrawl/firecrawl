vi.mock("../../../lib/crawl-regex", async () => {
  const { z } = await import("zod");
  return {
    addPathRegexIssues: vi.fn(),
    pathPatternsSchema: z.array(z.string()),
  };
});
import { agentController } from "../agent";
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
describe("Agent Alexandria rollout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([undefined, false, true])(
    "starts with rollout flag %s",
    async exchangeRetrieve => {
      const req = {
        body: {
          prompt: "Find government contracts",
          exchange: { enabled: true },
        },
        auth: { team_id: "team-test" },
        acuc: { flags: { exchangeRetrieve }, api_key: "test-key" },
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await agentController(req as any, res as any);
      expect(res.status).toHaveBeenCalledWith(200);
      const body = JSON.parse(
        vi.mocked(fetch).mock.calls[0][1]!.body as string,
      );
      expect(body.exchange).toEqual({ enabled: true });
      expect(body.teamId).toBe("team-test");
    },
  );
  it.each([false, true])(
    "preserves ordinary requests and ZDR (forced=%s)",
    async forced => {
      const req = {
        body: { prompt: "Find government contracts" },
        auth: { team_id: "team-test" },
        acuc: { flags: { forceZDR: forced }, api_key: "test-key" },
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await agentController(req as any, res as any);
      expect(res.status).toHaveBeenCalledWith(forced ? 400 : 200);
      expect(fetch).toHaveBeenCalledTimes(forced ? 0 : 1);
    },
  );
});
