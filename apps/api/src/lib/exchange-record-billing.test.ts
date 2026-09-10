import { beforeEach, expect, it, vi } from "vitest";
import { billExchangeRecord } from "./exchange-record-billing";
import { billTeam } from "../services/billing/credit_billing";
import { autumnService } from "../services/autumn/autumn.service";
import { reportExchangeBilling } from "./exchange";
vi.mock("../services/billing/credit_billing", () => ({ billTeam: vi.fn() }));
vi.mock("../services/autumn/autumn.service", () => ({
  autumnService: { checkCredits: vi.fn() },
}));
vi.mock("./exchange", () => ({ reportExchangeBilling: vi.fn() }));
const receipt = {
  success: true,
  accessEventId: "6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60",
  creditsCost: 32,
};
const context = { teamId: "consumer", apiKeyId: 1, maxCredits: 32 };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(autumnService.checkCredits).mockResolvedValue({
    allowed: true,
    remaining: 100,
  } as any);
  vi.mocked(billTeam).mockResolvedValue({ success: true });
});
it("queues the exact accepted price with a stable callback receipt without confirming early", async () => {
  expect(await billExchangeRecord(receipt, context)).toEqual({ success: true });
  expect(billTeam).toHaveBeenCalledWith(
    "consumer",
    32,
    1,
    { endpoint: "scrape", chargeId: `exchange:${receipt.accessEventId}` },
    undefined,
    {
      accessEventId: receipt.accessEventId,
      billingReference: `exchange:${receipt.accessEventId}`,
    },
  );
  expect(reportExchangeBilling).not.toHaveBeenCalled();
});
it("does not charge malformed or unexpectedly expensive responses", async () => {
  for (const input of [
    { ...receipt, creditsCost: -1 },
    { ...receipt, creditsCost: 33 },
    { success: false },
    { ...receipt, accessEventId: undefined },
  ]) {
    expect((await billExchangeRecord(input, context)).success).toBe(false);
  }
  expect(billTeam).not.toHaveBeenCalled();
});
it("does not charge preview teams and voids the delivered event", async () => {
  expect(
    await billExchangeRecord(receipt, { ...context, teamId: "preview_test" }),
  ).toEqual({ success: true });
  expect(billTeam).not.toHaveBeenCalled();
  expect(reportExchangeBilling).toHaveBeenCalledWith({
    accessEventId: receipt.accessEventId,
    status: "void",
  });
});
it("fails closed if balance cannot be authorized and leaves ambiguous enqueue failures pending", async () => {
  vi.mocked(autumnService.checkCredits).mockResolvedValue(null);
  expect(await billExchangeRecord(receipt, context)).toMatchObject({
    success: false,
    status: 503,
  });
  expect(billTeam).not.toHaveBeenCalled();
  vi.mocked(autumnService.checkCredits).mockResolvedValue({
    allowed: true,
    remaining: 100,
  } as any);
  vi.mocked(billTeam).mockResolvedValue({ success: false } as any);
  vi.mocked(reportExchangeBilling).mockClear();
  expect(await billExchangeRecord(receipt, context)).toMatchObject({
    success: false,
    status: 503,
  });
  expect(reportExchangeBilling).not.toHaveBeenCalled();
});
