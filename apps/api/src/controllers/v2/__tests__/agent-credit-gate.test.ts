vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: vi.fn(),
    hasAutoTopUp: vi.fn(),
    hostedMcpFeatureId: async () => "MCP_CREDITS",
  },
  CREDITS_FEATURE_ID: "CREDITS",
}));

import { gateAgentCredits } from "../agent-credit-gate";
import { autumnService } from "../../../services/autumn/autumn.service";

const checkCredits = vi.mocked(autumnService.checkCredits);
const hasAutoTopUp = vi.mocked(autumnService.hasAutoTopUp);

const gate = (requestedMaxCredits?: number, orgId: string | null = "org-1") =>
  gateAgentCredits({
    teamId: "team-1",
    orgId,
    apiKeyId: 7,
    requestedMaxCredits,
  });

const asRequested = (maxCredits?: number) => ({
  allowed: true,
  maxCredits,
  stopOnInsufficientCredits: false,
});

describe("gateAgentCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasAutoTopUp.mockResolvedValue(false);
  });

  it("blocks a team without overage at a zero balance", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    expect(await gate()).toEqual({ allowed: false, balance: 0 });
    expect(checkCredits).toHaveBeenCalledTimes(1);
    expect(checkCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        orgId: "org-1",
        value: 20,
        properties: expect.objectContaining({ apiKeyId: 7 }),
      }),
    );
  });

  it.each([9.223372036854776e18, Number.MAX_SAFE_INTEGER])(
    "runs a team with an unlimited balance (%d) as requested without probing past it",
    async remaining => {
      checkCredits.mockResolvedValueOnce({ allowed: true, remaining });

      expect(await gate(5000)).toEqual(asRequested(5000));
      expect(checkCredits).toHaveBeenCalledTimes(1);
      expect(hasAutoTopUp).not.toHaveBeenCalled();
    },
  );

  it("still probes past a large but finite balance", async () => {
    checkCredits
      .mockResolvedValueOnce({
        allowed: true,
        remaining: Number.MAX_SAFE_INTEGER - 1,
      })
      .mockResolvedValueOnce({
        allowed: true,
        remaining: Number.MAX_SAFE_INTEGER - 1,
      });

    expect(await gate()).toEqual(asRequested(undefined));
    expect(checkCredits).toHaveBeenCalledTimes(2);
  });

  it("blocks a team below the minimum and reports its balance", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 12 });

    expect(await gate(5000)).toEqual({ allowed: false, balance: 12 });
  });

  it("caps maxCredits at the balance for a team without overage", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 640.6 })
      .mockResolvedValueOnce({ allowed: false, remaining: 640.6 });

    expect(await gate()).toEqual({
      allowed: true,
      maxCredits: 640,
      stopOnInsufficientCredits: true,
    });
    expect(checkCredits).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: 660 }),
    );
  });

  it("never starts a capped run with a cap of zero or below", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 0 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0 });

    expect(await gate()).toEqual({ allowed: false, balance: 0 });
  });

  it("keeps the default cap when the balance is above it", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 10000 })
      .mockResolvedValueOnce({ allowed: false, remaining: 10000 });

    expect(await gate()).toEqual({
      allowed: true,
      maxCredits: 2500,
      stopOnInsufficientCredits: true,
    });
  });

  it("caps a requested maxCredits above the balance", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 1000 })
      .mockResolvedValueOnce({ allowed: false, remaining: 1000 });

    expect(await gate(8000)).toMatchObject({
      maxCredits: 1000,
      stopOnInsufficientCredits: true,
    });
  });

  it("keeps a requested maxCredits below the balance but still stops at zero", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 1000 })
      .mockResolvedValueOnce({ allowed: false, remaining: 1000 });

    expect(await gate(300)).toEqual({
      allowed: true,
      maxCredits: 300,
      stopOnInsufficientCredits: true,
    });
  });

  it("passes an overage team through as requested", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 100 })
      .mockResolvedValueOnce({ allowed: true, remaining: 100 });

    expect(await gate(8000)).toEqual(asRequested(8000));
    expect(hasAutoTopUp).not.toHaveBeenCalled();
  });

  it("passes an overage team already below zero through as requested", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: -5000 })
      .mockResolvedValueOnce({ allowed: true, remaining: -5000 });

    expect(await gate()).toEqual(asRequested(undefined));
    expect(checkCredits).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: 20 }),
    );
  });

  it("passes an auto-recharge team through as requested", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 100 })
      .mockResolvedValueOnce({ allowed: false, remaining: 100 });
    hasAutoTopUp.mockResolvedValueOnce(true);

    expect(await gate(4000)).toEqual(asRequested(4000));
    expect(hasAutoTopUp).toHaveBeenCalledWith("org-1");
  });

  it("fails open when the first check can't be answered", async () => {
    checkCredits.mockResolvedValueOnce(null);

    expect(await gate(4000)).toEqual(asRequested(4000));
    expect(checkCredits).toHaveBeenCalledTimes(1);
  });

  it("fails open when the overage check can't be answered", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 100 })
      .mockResolvedValueOnce(null);

    expect(await gate(4000)).toEqual(asRequested(4000));
  });

  it("fails open on an allowed answer with no usable balance", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: true, remaining: Infinity });

    expect(await gate()).toEqual(asRequested(undefined));
    expect(checkCredits).toHaveBeenCalledTimes(1);
  });

  it("fails open without an org", async () => {
    expect(await gate(4000, null)).toEqual(asRequested(4000));
    expect(checkCredits).not.toHaveBeenCalled();
  });
});

describe("gateAgentCredits for a hosted MCP run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasAutoTopUp.mockResolvedValue(false);
  });

  const hostedGate = (requestedMaxCredits?: number) =>
    gateAgentCredits({
      teamId: "team-1",
      orgId: "org-1",
      apiKeyId: 7,
      requestedMaxCredits,
      hostedMcp: true,
    });

  it("checks MCP credits, the balance its charges are tracked on", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 300 })
      .mockResolvedValueOnce({ allowed: false, remaining: 300 });

    expect(await hostedGate(1000)).toEqual({
      allowed: true,
      maxCredits: 300,
      stopOnInsufficientCredits: true,
    });
    expect(checkCredits).toHaveBeenCalledTimes(2);
    for (const [check] of checkCredits.mock.calls) {
      expect(check.featureId).toBe("MCP_CREDITS");
    }
  });

  it("refuses like any run when the check refuses", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    expect(await hostedGate()).toEqual({ allowed: false, balance: 0 });
  });

  it("leaves the feature to the default for a run the hosted MCP did not start", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    await gate();

    expect(checkCredits.mock.calls[0][0].featureId).toBeUndefined();
  });
});
