vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: vi.fn(),
    hasAutoTopUp: vi.fn(),
    mcpCreditsAvailable: vi.fn(),
  },
}));

import { gateAgentCredits } from "../agent-credit-gate";
import { autumnService } from "../../../services/autumn/autumn.service";

const checkCredits = vi.mocked(autumnService.checkCredits);
const hasAutoTopUp = vi.mocked(autumnService.hasAutoTopUp);
const mcpCreditsAvailable = vi.mocked(autumnService.mcpCreditsAvailable);

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
    mcpCreditsAvailable.mockResolvedValue(1000);
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
  const hosted = (requestedMaxCredits?: number) =>
    gateAgentCredits({
      teamId: "team-1",
      orgId: "org-1",
      apiKeyId: 7,
      requestedMaxCredits,
      hostedMcp: true,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    hasAutoTopUp.mockResolvedValue(false);
    mcpCreditsAvailable.mockResolvedValue(0);
  });

  it("starts a run MCP credits pay for at a zero balance, capped at them", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    mcpCreditsAvailable.mockResolvedValueOnce(300);

    expect(await hosted()).toEqual({
      allowed: true,
      maxCredits: 300,
      stopOnInsufficientCredits: true,
    });
    expect(mcpCreditsAvailable).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        orgId: "org-1",
        value: 2500,
      }),
    );
  });

  it("adds MCP credits to what is left of the balance below the minimum", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 12 });
    mcpCreditsAvailable.mockResolvedValueOnce(10);

    expect(await hosted(5000)).toEqual({
      allowed: true,
      maxCredits: 22,
      stopOnInsufficientCredits: true,
    });
  });

  it("admits a cap below the minimum when MCP credits clear the minimum", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    mcpCreditsAvailable.mockResolvedValueOnce(20);

    expect(await hosted(10)).toEqual({
      allowed: true,
      maxCredits: 10,
      stopOnInsufficientCredits: true,
    });
    expect(mcpCreditsAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ value: 20 }),
    );
  });

  it("leaves a non-positive maxCredits to the balance alone", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    mcpCreditsAvailable.mockResolvedValue(1000);

    expect(await hosted(-1)).toEqual({ allowed: false, balance: 0 });
    expect(mcpCreditsAvailable).not.toHaveBeenCalled();
  });

  it("refuses when the balance and MCP credits together are below the minimum", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 12 });
    mcpCreditsAvailable.mockResolvedValueOnce(7);

    expect(await hosted()).toEqual({ allowed: false, balance: 12 });
  });

  it("counts MCP credits alone when a spend limit refused with balance left", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 5000 });
    mcpCreditsAvailable.mockResolvedValueOnce(19);
    expect(await hosted()).toEqual({ allowed: false, balance: 5000 });

    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 5000 });
    mcpCreditsAvailable.mockResolvedValueOnce(100);
    expect(await hosted()).toEqual({
      allowed: true,
      maxCredits: 100,
      stopOnInsufficientCredits: true,
    });
  });

  it("raises the balance cap by the MCP credits, up to the request", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 640.6 })
      .mockResolvedValueOnce({ allowed: false, remaining: 640.6 });
    mcpCreditsAvailable.mockResolvedValueOnce(300);
    expect(await hosted()).toEqual({
      allowed: true,
      maxCredits: 940,
      stopOnInsufficientCredits: true,
    });

    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 640 })
      .mockResolvedValueOnce({ allowed: false, remaining: 640 });
    mcpCreditsAvailable.mockResolvedValueOnce(2500);
    expect(await hosted(1000)).toMatchObject({ maxCredits: 1000 });
  });

  it("keeps the balance cap when MCP credits are used up", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 640 })
      .mockResolvedValueOnce({ allowed: false, remaining: 640 });

    expect(await hosted()).toEqual({
      allowed: true,
      maxCredits: 640,
      stopOnInsufficientCredits: true,
    });
  });

  it("starts a capped run MCP credits pay for once the balance is spent", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 0 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0 });
    mcpCreditsAvailable.mockResolvedValueOnce(50);
    expect(await hosted()).toMatchObject({ allowed: true, maxCredits: 50 });

    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 0 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0 });
    expect(await hosted()).toEqual({ allowed: false, balance: 0 });
  });

  it("runs as requested wherever the balance alone already does", async () => {
    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 100 })
      .mockResolvedValueOnce({ allowed: true, remaining: 100 });
    expect(await hosted(8000)).toEqual(asRequested(8000));

    checkCredits
      .mockResolvedValueOnce({ allowed: true, remaining: 100 })
      .mockResolvedValueOnce({ allowed: false, remaining: 100 });
    hasAutoTopUp.mockResolvedValueOnce(true);
    expect(await hosted(4000)).toEqual(asRequested(4000));

    checkCredits.mockResolvedValueOnce(null);
    expect(await hosted(4000)).toEqual(asRequested(4000));
    expect(mcpCreditsAvailable).not.toHaveBeenCalled();
  });

  it("never asks about MCP credits for a run the hosted MCP did not start", async () => {
    checkCredits.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    mcpCreditsAvailable.mockResolvedValue(1000);

    expect(await gate()).toEqual({ allowed: false, balance: 0 });
    expect(mcpCreditsAvailable).not.toHaveBeenCalled();
  });
});
