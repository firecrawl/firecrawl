import { vi } from "vitest";

const mockExecuteSearch = vi.fn();

vi.mock("../../../search/execute", () => ({
  executeSearch: (...args: any[]) => mockExecuteSearch(...args),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn().mockResolvedValue(undefined),
  logSearch: vi.fn().mockResolvedValue(undefined),
  logResearchEndpoint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/keyless", () => ({
  KEYLESS_FREE_TIER_LIMIT_MESSAGE: "keyless limit reached",
  adjustKeylessCredits: vi.fn().mockResolvedValue(undefined),
  keylessLimitBody: vi.fn().mockResolvedValue({ success: false }),
  keylessProviderToolsBody: vi.fn(() => ({ success: false })),
  logKeylessCreditUsage: vi.fn().mockResolvedValue(undefined),
  reserveKeylessCredits: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../../lib/keyless-credit-projection", () => ({
  projectSearchTotalCredits: () => 0,
}));

vi.mock("../../../lib/threat-protection/request", () => ({
  resolveThreatProtection: vi.fn().mockResolvedValue({ policy: null }),
  checkUrlsAgainstThreatPolicy: vi.fn(),
}));

vi.mock("../../../lib/key-restriction", () => ({
  actionTypesOf: () => [],
  formatTypesOf: () => [],
  checkKeyFormatRestriction: vi.fn().mockResolvedValue({ allowed: true }),
  checkKeyEndpointRestriction: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../../../lib/alexandria-activity", () => ({
  markAlexandriaActivity: vi.fn(),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { searchController } from "../search";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";

function makeRes() {
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

/** Runs one plain web search as `acuc` and returns the context the search ran with. */
async function searchContextFor(acuc: unknown, teamId = TEAM_ID) {
  const res = makeRes();
  await searchController(
    {
      body: { query: "http client" },
      headers: {},
      auth: { team_id: teamId },
      acuc,
    } as any,
    res,
  );
  expect(res.status).toHaveBeenCalledWith(200);
  expect(mockExecuteSearch).toHaveBeenCalledTimes(1);
  return mockExecuteSearch.mock.calls[0][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteSearch.mockResolvedValue({
    response: { web: [] },
    totalResultsCount: 0,
    indexResultsCount: 0,
    searchCredits: 0,
    scrapeCredits: 0,
    totalCredits: 0,
    shouldScrape: false,
  });
});

describe("the team plan class a v2 search runs with", () => {
  it.each(["free", "self_serve", "contract"] as const)(
    "is %s when the team's chunk says so and no flag overrides it",
    async plan_class => {
      const context = await searchContextFor({
        api_key_id: 7,
        flags: {},
        plan_class,
      });

      expect(context.teamPlanClass).toBe(plan_class);
    },
  );

  it("is contract for a team under negotiated terms, whatever plan it pays for", async () => {
    for (const flags of [
      { signedContract: true },
      { enterprisePilot: { startDate: "2026-01-01T00:00:00Z" } },
      { searchZDR: "allowed" },
      { usOnly: true },
    ]) {
      mockExecuteSearch.mockClear();
      const context = await searchContextFor({
        api_key_id: 7,
        flags,
        plan_class: "self_serve",
      });

      expect(context.teamPlanClass).toBe("contract");
    }
  });

  it("is free for a keyless request", async () => {
    const context = await searchContextFor(
      { api_key_id: 0, flags: null, plan_class: "free" },
      "preview_keyless_203.0.113.8",
    );

    expect(context.teamPlanClass).toBe("free");
  });

  it("is not stated when the chunk carries no plan class", async () => {
    const context = await searchContextFor({ api_key_id: 7, flags: {} });

    expect(context).toHaveProperty("teamPlanClass", undefined);
  });

  it("is not stated without a chunk", async () => {
    const context = await searchContextFor(undefined);

    expect(context).toHaveProperty("teamPlanClass", undefined);
  });
});
