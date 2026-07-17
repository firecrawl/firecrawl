import type { MockedFunction } from "vitest";

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: vi.fn(),
  },
  CREDITS_FEATURE_ID: "CREDITS",
}));

vi.mock("../../services/autumn/usage", () => ({
  getTeamBalance: vi.fn(),
}));

vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: vi.fn(),
}));

vi.mock("../../controllers/auth", () => ({
  getACUCTeam: vi.fn(),
}));

vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { fireclawController } from "../../controllers/v1/fireclaw";
import { autumnService } from "../../services/autumn/autumn.service";
import { getTeamBalance } from "../../services/autumn/usage";
import { billTeam } from "../../services/billing/credit_billing";

const checkCreditsMock = autumnService.checkCredits as MockedFunction<
  typeof autumnService.checkCredits
>;
const getTeamBalanceMock = getTeamBalance as MockedFunction<
  typeof getTeamBalance
>;
const billTeamMock = billTeam as MockedFunction<typeof billTeam>;

function buildReq(overrides: any = {}): any {
  return {
    body: { plays: 1 },
    auth: { team_id: "team_test", org_id: "org_test" },
    acuc: { api_key_id: 1 },
    ...overrides,
  };
}

function buildRes(): any {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((payload: any) => {
      res.body = payload;
      return res;
    }),
  };
  return res;
}

describe("fireclawController credit gating (Autumn)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTeamBalanceMock.mockResolvedValue({
      remaining: 4000,
      granted: 5000,
      planCredits: 5000,
      usage: 1000,
      unlimited: false,
      periodStart: null,
      periodEnd: null,
    } as any);
  });

  it("402s when Autumn denies the full multi-play cost", async () => {
    const req = buildReq({ body: { plays: 10 } }); // 10 * 100 = 1000
    const res = buildRes();
    checkCreditsMock.mockResolvedValue({ allowed: false, remaining: 50 });

    await fireclawController(req, res);

    // Checked against the real cost, not a single play
    expect(checkCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team_test", value: 1000 }),
    );
    expect(res.statusCode).toBe(402);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("50"); // surfaces Autumn's remaining
    expect(billTeamMock).not.toHaveBeenCalled();
  });

  it("bills and returns the Autumn balance when allowed", async () => {
    const req = buildReq({ body: { plays: 2 } }); // 2 * 100 = 200
    const res = buildRes();
    checkCreditsMock.mockResolvedValue({ allowed: true, remaining: 5000 });

    await fireclawController(req, res);

    expect(checkCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({ value: 200 }),
    );
    expect(billTeamMock).toHaveBeenCalledWith(
      "team_test",
      200,
      1,
      expect.objectContaining({ endpoint: "fireclaw" }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: true,
        credits_billed: 200,
        plays: 2,
        remaining_credits: 4000, // from getTeamBalance
      }),
    );
  });

  it("fails open and bills when Autumn is unavailable (checkCredits null)", async () => {
    const req = buildReq({ body: { plays: 3 } });
    const res = buildRes();
    checkCreditsMock.mockResolvedValue(null);

    await fireclawController(req, res);

    expect(billTeamMock).toHaveBeenCalledWith(
      "team_test",
      300,
      1,
      expect.objectContaining({ endpoint: "fireclaw" }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
