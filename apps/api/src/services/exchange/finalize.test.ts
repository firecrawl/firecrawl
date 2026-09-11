import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  team: vi.fn(),
  firebill: vi.fn(),
  autumn: vi.fn(),
}));
vi.mock("../../controllers/auth", () => ({ getACUCTeam: mocks.team }));
vi.mock("../autumn/autumn.service", () => ({
  autumnService: { finalizeCreditsLock: mocks.autumn },
}));
vi.mock("../autumn/firebill", () => ({
  firebillConfigured: () => true,
  firebillFinalize: mocks.firebill,
}));
import { finalizeExchangeHold } from "./finalize";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.firebill.mockResolvedValue(true);
  mocks.autumn.mockResolvedValue(true);
});
it.each(["confirm", "release"] as const)(
  "defers a token-bearing %s until its customer resolves",
  async action => {
    const hold = {
      lockId: "lock",
      action,
      teamId: "team",
      externalRequestId: "operation",
      featureId: "credits",
      heldValue: 3,
    };
    expect(await finalizeExchangeHold(hold)).toBe(false);
    expect(mocks.firebill).not.toHaveBeenCalled();
    expect(mocks.autumn).not.toHaveBeenCalled();
    mocks.team.mockResolvedValue({ org_id: "org" });
    expect(await finalizeExchangeHold(hold)).toBe(true);
    expect(mocks.firebill).toHaveBeenCalledWith({ ...hold, customerId: "org" });
  },
);
it("keeps ordinary hold finalization on the existing billing service", async () => {
  const hold = { lockId: "lock", action: "release" as const, teamId: "team" };
  expect(await finalizeExchangeHold(hold)).toBe(true);
  expect(mocks.autumn).toHaveBeenCalledWith(hold);
  expect(mocks.team).not.toHaveBeenCalled();
});
