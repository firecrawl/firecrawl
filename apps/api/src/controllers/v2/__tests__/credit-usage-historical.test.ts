import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Response } from "express";
import type { RequestWithAuth } from "../types";

vi.mock("../../../services/autumn/usage", () => ({
  getTeamHistoricalUsage: vi.fn(),
  getTeamHistoricalUsageByApiKey: vi.fn(),
  getTeamUsageForRange: vi.fn(),
}));
import {
  getTeamHistoricalUsage,
  getTeamHistoricalUsageByApiKey,
  getTeamUsageForRange,
} from "../../../services/autumn/usage";
import { creditUsageHistoricalController } from "../credit-usage-historical";

const call = async (query: Record<string, unknown>) => {
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  await creditUsageHistoricalController(
    {
      query,
      auth: { team_id: "authenticated-team" },
    } as unknown as RequestWithAuth,
    res as unknown as Response,
  );
  return res;
};
beforeEach(() => vi.resetAllMocks());

it.each(["day", "week", "month"] as const)(
  "returns %s usage with window metadata",
  async timeRange => {
    const result = {
      window: {
        timeRange,
        binSize: timeRange === "day" ? "hour" : "day",
        startDate: "2026-09-02T00:00:00Z",
        endDate: "2026-10-02T00:00:00Z",
      },
      periods: [],
    };
    vi.mocked(getTeamUsageForRange).mockResolvedValue(
      result as Awaited<ReturnType<typeof getTeamUsageForRange>>,
    );
    const res = await call({ timeRange, team_id: "untrusted-team" });
    expect(getTeamUsageForRange).toHaveBeenCalledWith(
      "authenticated-team",
      timeRange,
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, ...result });
  },
);

it.each([
  { timeRange: "year" },
  { timeRange: ["day", "week"] },
  { timeRange: "" },
  { timeRange: "week", byApiKey: "true" },
])("rejects unsupported queries before contacting billing: %j", async query => {
  const res = await call(query);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ success: false }),
  );
  expect(getTeamUsageForRange).not.toHaveBeenCalled();
  expect(getTeamHistoricalUsage).not.toHaveBeenCalled();
});

it("preserves the default sorted monthly response", async () => {
  vi.mocked(getTeamHistoricalUsage).mockResolvedValue([
    { startDate: "2026-09-01T00:00:00Z", endDate: null, creditsUsed: 3 },
    {
      startDate: "2026-08-01T00:00:00Z",
      endDate: "2026-09-01T00:00:00Z",
      creditsUsed: 2,
    },
  ]);
  const res = await call({});
  expect(
    res.json.mock.calls[0][0].periods.map(
      (p: { creditsUsed: number }) => p.creditsUsed,
    ),
  ).toEqual([2, 3]);
  expect(res.json.mock.calls[0][0]).not.toHaveProperty("window");
});

it("preserves API-key monthly history", async () => {
  vi.mocked(getTeamHistoricalUsageByApiKey).mockResolvedValue([]);
  const res = await call({ byApiKey: "true" });
  expect(getTeamHistoricalUsageByApiKey).toHaveBeenCalledWith(
    "authenticated-team",
  );
  expect(res.json).toHaveBeenCalledWith({ success: true, periods: [] });
});
