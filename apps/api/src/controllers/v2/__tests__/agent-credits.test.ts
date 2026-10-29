vi.mock("../../../lib/crawl-regex", async () => {
  const { z } = await import("zod");
  return {
    addPathRegexIssues: vi.fn(),
    pathPatternsSchema: z.array(z.string()),
  };
});
import { agentController } from "../agent";
vi.mock("../../../lib/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
    USE_DB_AUTHENTICATION: true,
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

import { agentConsumeFreeRequestIfLeft } from "../../../db/rpc";
import { autumnService } from "../../../services/autumn/autumn.service";

const consumeFreeRequest = vi.mocked(agentConsumeFreeRequestIfLeft);
const checkCredits = vi.mocked(autumnService.checkCredits);
const hasAutoTopUp = vi.mocked(autumnService.hasAutoTopUp);

async function startAgent(body: Record<string, unknown>) {
  const req = {
    body: { prompt: "Find government contracts", ...body },
    auth: { team_id: "team-test", org_id: "org-test" },
    acuc: {
      flags: {},
      api_key: "test-key",
      api_key_id: 3,
    },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await agentController(req as any, res as any);
  const call = vi.mocked(fetch).mock.calls[0];
  return {
    res,
    sent: call ? JSON.parse(call[1]!.body as string) : undefined,
  };
}

describe("agent credit gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasAutoTopUp.mockResolvedValue(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("checks credits for maxCredits above the free cap, even with free requests left", async () => {
    consumeFreeRequest.mockResolvedValue([{ consumed: true }]);
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const { res, sent } = await startAgent({ maxCredits: 5000 });

    expect(consumeFreeRequest).not.toHaveBeenCalled();
    expect(checkCredits).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(sent).toBeUndefined();
  });

  it("refuses a paid run at a zero balance with the balance in the error", async () => {
    consumeFreeRequest.mockResolvedValue([{ consumed: false }]);
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const { res, sent } = await startAgent({});

    expect(res.status).toHaveBeenCalledWith(402);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("balance is 0 credits");
    expect(payload.error).toContain("Add credits");
    expect(sent).toBeUndefined();
  });

  it("still starts a free daily run at a balance of zero or below", async () => {
    consumeFreeRequest.mockResolvedValue([{ consumed: true }]);
    checkCredits.mockResolvedValue({ allowed: false, remaining: 0 });

    const { res, sent } = await startAgent({});

    expect(checkCredits).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(sent.isFreeRequest).toBe(true);
    expect(sent.stopOnInsufficientCredits).toBeUndefined();
  });

  it("sends the capped maxCredits and the stop flag for a team without overage", async () => {
    consumeFreeRequest.mockResolvedValue([{ consumed: false }]);
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 700 })
      .mockResolvedValueOnce({ allowed: false, remaining: 700 });

    const { res, sent } = await startAgent({ maxCredits: 2000 });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sent.isFreeRequest).toBe(false);
    expect(sent.maxCredits).toBe(700);
    expect(sent.stopOnInsufficientCredits).toBe(true);
  });

  it("leaves an overage team's request untouched", async () => {
    consumeFreeRequest.mockResolvedValue([{ consumed: false }]);
    checkCredits.mockResolvedValue({ allowed: true, remaining: 50 });

    const { res, sent } = await startAgent({ maxCredits: 9000 });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sent.maxCredits).toBe(9000);
    expect(sent.stopOnInsufficientCredits).toBeUndefined();
  });

  it("leaves an auto-recharge team's request untouched", async () => {
    consumeFreeRequest.mockResolvedValue([{ consumed: false }]);
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 50 })
      .mockResolvedValueOnce({ allowed: false, remaining: 50 });
    hasAutoTopUp.mockResolvedValueOnce(true);

    const { res, sent } = await startAgent({ maxCredits: 9000 });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sent.maxCredits).toBe(9000);
    expect(sent.stopOnInsufficientCredits).toBeUndefined();
  });

  it("fails open when billing can't answer", async () => {
    consumeFreeRequest.mockResolvedValue([{ consumed: false }]);
    checkCredits.mockResolvedValue(null);

    const { res, sent } = await startAgent({ maxCredits: 9000 });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sent.maxCredits).toBe(9000);
    expect(sent.stopOnInsufficientCredits).toBeUndefined();
  });
});
