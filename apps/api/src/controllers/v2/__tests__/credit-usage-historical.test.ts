import type { Response } from "express";
import type { RequestWithAuth } from "../types";

const mocks = vi.hoisted(() => ({
  getTeamHistoricalUsage: vi.fn(),
  getTeamHistoricalUsageByApiKey: vi.fn(),
  getTeamHistoricalUsageByEndpoint: vi.fn(),
}));

vi.mock("../../../services/autumn/usage", () => mocks);

import { creditUsageHistoricalController } from "../credit-usage-historical";

function request(query: Record<string, unknown>) {
  return { query, auth: { team_id: "team-1" } } as unknown as RequestWithAuth;
}

function response() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res as Response & { status: any; json: any };
}

const MONTH = {
  startDate: "2026-04-01T00:00:00.000Z",
  endDate: null,
  creditsUsed: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTeamHistoricalUsage.mockResolvedValue([MONTH]);
  mocks.getTeamHistoricalUsageByApiKey.mockResolvedValue([
    { ...MONTH, apiKey: "Default" },
  ]);
  mocks.getTeamHistoricalUsageByEndpoint.mockResolvedValue([
    { ...MONTH, endpoint: "scrape" },
  ]);
});

describe("creditUsageHistoricalController", () => {
  it("answers with monthly totals and no bin field when no option is given", async () => {
    const res = response();
    await creditUsageHistoricalController(request({}), res);

    expect(mocks.getTeamHistoricalUsage).toHaveBeenCalledWith(
      "team-1",
      "month",
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, periods: [MONTH] });
    expect(JSON.stringify(res.json.mock.calls[0][0])).toBe(
      JSON.stringify({ success: true, periods: [MONTH] }),
    );
  });

  it("keeps the byApiKey response as it was", async () => {
    const res = response();
    await creditUsageHistoricalController(request({ byApiKey: "true" }), res);

    expect(mocks.getTeamHistoricalUsageByApiKey).toHaveBeenCalledWith(
      "team-1",
      "month",
    );
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      periods: [{ ...MONTH, apiKey: "Default" }],
    });
  });

  it("breaks usage down by endpoint", async () => {
    const res = response();
    await creditUsageHistoricalController(request({ byEndpoint: "true" }), res);

    expect(mocks.getTeamHistoricalUsageByEndpoint).toHaveBeenCalledWith(
      "team-1",
      "month",
    );
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      periods: [{ ...MONTH, endpoint: "scrape" }],
    });
  });

  it("passes the bin through and echoes it", async () => {
    const res = response();
    await creditUsageHistoricalController(
      request({ byEndpoint: "true", bin: "day" }),
      res,
    );

    expect(mocks.getTeamHistoricalUsageByEndpoint).toHaveBeenCalledWith(
      "team-1",
      "day",
    );
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      bin: "day",
      periods: [{ ...MONTH, endpoint: "scrape" }],
    });
  });

  it("echoes an explicit month bin", async () => {
    const res = response();
    await creditUsageHistoricalController(request({ bin: "month" }), res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      bin: "month",
      periods: [MONTH],
    });
  });

  it("sorts periods by start date", async () => {
    mocks.getTeamHistoricalUsageByEndpoint.mockResolvedValue([
      { ...MONTH, endpoint: "scrape" },
      {
        startDate: "2026-03-01T00:00:00.000Z",
        endDate: "2026-04-01T00:00:00.000Z",
        endpoint: "crawl",
        creditsUsed: 2,
      },
    ]);
    const res = response();
    await creditUsageHistoricalController(request({ byEndpoint: "true" }), res);

    expect(
      res.json.mock.calls[0][0].periods.map((p: any) => p.endpoint),
    ).toEqual(["crawl", "scrape"]);
  });

  it.each([["week"], [["day", "month"]]])("rejects bin %j", async bin => {
    const res = response();
    await creditUsageHistoricalController(request({ bin }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'bin must be "month" or "day".',
    });
    expect(mocks.getTeamHistoricalUsage).not.toHaveBeenCalled();
  });

  it("rejects byApiKey together with byEndpoint", async () => {
    const res = response();
    await creditUsageHistoricalController(
      request({ byApiKey: "true", byEndpoint: "true" }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.getTeamHistoricalUsageByApiKey).not.toHaveBeenCalled();
    expect(mocks.getTeamHistoricalUsageByEndpoint).not.toHaveBeenCalled();
  });
});
