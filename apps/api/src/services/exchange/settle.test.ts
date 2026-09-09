import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  del: vi.fn(),
  bill: vi.fn(),
  forward: vi.fn(),
}));
vi.mock("../queue-service", () => ({
  getRedisConnection: () => ({ set: mocks.set, del: mocks.del }),
}));
vi.mock("../billing/credit_billing", () => ({ billTeam: mocks.bill }));
vi.mock("../../lib/exchange-proxy", () => ({
  forwardToExchange: mocks.forward,
}));
import { settleExchangeCall } from "./settle";
const input = {
  teamId: "team",
  apiKeyId: 1,
  requestId: "request-1",
  timeoutMs: 5000,
  body: { requests: [{ provider: "p", capability: "c" }] },
  logger: { error: vi.fn() } as any,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.set.mockResolvedValue("OK");
  mocks.del.mockResolvedValue(1);
  mocks.bill.mockResolvedValue({ success: true });
  mocks.forward.mockResolvedValue({
    status: 200,
    body: { creditsCost: 3, results: [] },
  });
});
describe("provider settlement without credit reservations", () => {
  it("scopes duplicate identity to the team and request body", async () => {
    await settleExchangeCall(input);
    await settleExchangeCall(input);
    await settleExchangeCall({ ...input, teamId: "other" });
    await settleExchangeCall({ ...input, body: { provider: "other" } });
    const keys = mocks.set.mock.calls.map(c => c[0]);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });
  it("fails closed when request deduplication is unavailable", async () => {
    mocks.set.mockRejectedValue(new Error("Redis down"));
    expect((await settleExchangeCall(input)).status).toBe(503);
    expect(mocks.forward).not.toHaveBeenCalled();
  });
  it("relays upstream failure without a debit", async () => {
    mocks.forward.mockResolvedValue({
      status: 400,
      body: { error: "Invalid input" },
    });
    expect((await settleExchangeCall(input)).status).toBe(400);
    expect(mocks.bill).not.toHaveBeenCalled();
  });
  it("retains ambiguous requests after a timeout to avoid duplicate execution", async () => {
    mocks.forward.mockRejectedValue(new Error("Timeout"));
    await expect(settleExchangeCall(input)).rejects.toThrow("Timeout");
    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.bill).not.toHaveBeenCalled();
  });
  it.each([-1, 101, 1.5, undefined])(
    "does not charge invalid cost %s",
    async creditsCost => {
      mocks.forward.mockResolvedValue({ status: 200, body: { creditsCost } });
      expect((await settleExchangeCall(input)).status).toBe(502);
      expect(mocks.bill).not.toHaveBeenCalled();
    },
  );
  it("charges only the returned total for a partially successful batch", async () => {
    mocks.forward.mockResolvedValue({
      status: 200,
      body: {
        creditsCost: 2,
        results: [{ creditsCost: 2 }, { error: "failed" }],
      },
    });
    await settleExchangeCall({ ...input, body: { requests: [{}, {}] } });
    expect(mocks.bill.mock.calls[0][1]).toBe(2);
  });
  it("does not bill free results or preview teams", async () => {
    mocks.forward.mockResolvedValue({ status: 200, body: { creditsCost: 0 } });
    await settleExchangeCall(input);
    mocks.forward.mockResolvedValue({ status: 200, body: { creditsCost: 3 } });
    await settleExchangeCall({ ...input, teamId: "preview" });
    expect(mocks.bill).not.toHaveBeenCalled();
  });
});
