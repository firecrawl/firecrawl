/**
 * Unit tests for AutumnService.coversWithMcpCredits: whether a hosted MCP
 * charge fits the team's MCP credits, which such charges spend before the
 * endpoint's own feature.
 */

import { vi } from "vitest";

const { mockCheck, mockAutumnClient, state } = vi.hoisted(() => {
  const mockCheck = vi.fn<(args: any) => Promise<any>>();
  const mockAutumnClient = {
    customers: { getOrCreate: vi.fn(), get: vi.fn() },
    entities: {
      get: vi.fn().mockResolvedValue({ id: "team-1" }),
      create: vi.fn(),
    },
    balances: { finalize: vi.fn() },
    check: mockCheck,
    track: vi.fn(),
  };
  return {
    mockCheck,
    mockAutumnClient,
    state: {
      gatewayStubRow: null as unknown,
      configRef: {} as Record<string, unknown>,
    },
  };
});

vi.mock("../client", () => ({
  autumnClient: mockAutumnClient,
}));

vi.mock("../../queue-service", () => ({
  getFirebillTrackRetryQueue: () => ({ add: vi.fn() }),
}));

vi.mock("../../../db/connection", () => ({
  get dbRr() {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve(
                state.gatewayStubRow ? [state.gatewayStubRow] : [],
              ),
          }),
        }),
      }),
    };
  },
}));

vi.mock("../../../config", () => ({
  get config() {
    return {
      MCP_CREDITS_FEATURE_ID: "MCP_CREDITS",
      ...state.configRef,
    };
  },
}));

import { AutumnService, MCP_CREDITS_FEATURE_ID } from "../autumn.service";

const charge = {
  teamId: "team-1",
  orgId: "org-1",
  value: 5,
  properties: { source: "billTeam", endpoint: "scrape" },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.gatewayStubRow = null;
  state.configRef = { MCP_CREDITS_ENABLED: true };
  mockCheck.mockResolvedValue({
    allowed: true,
    customerId: "org-1",
    balance: { remaining: 100 },
  });
});

describe("coversWithMcpCredits", () => {
  it("reads the feature id from config", () => {
    expect(MCP_CREDITS_FEATURE_ID).toBe("MCP_CREDITS");
  });

  it("covers a charge the team's MCP credits can pay for", async () => {
    expect(await new AutumnService().coversWithMcpCredits(charge)).toBe(true);
    expect(mockCheck).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        customerId: "org-1",
        entityId: "team-1",
        featureId: "MCP_CREDITS",
        requiredBalance: 5,
        properties: charge.properties,
      }),
    );
  });

  it("does not cover a charge once the MCP credits are used up", async () => {
    mockCheck.mockResolvedValue({
      allowed: false,
      customerId: "org-1",
      balance: { remaining: 2 },
    });

    expect(await new AutumnService().coversWithMcpCredits(charge)).toBe(false);
  });

  it("does not cover a charge for a team whose plan has no MCP credits", async () => {
    mockCheck.mockResolvedValue({
      allowed: false,
      customerId: "org-1",
      balance: null,
    });

    expect(await new AutumnService().coversWithMcpCredits(charge)).toBe(false);
  });

  it("does not cover a charge when Autumn can't answer", async () => {
    mockCheck.mockRejectedValue(new Error("ECONNRESET"));

    expect(await new AutumnService().coversWithMcpCredits(charge)).toBe(false);
  });

  it("never asks Autumn while MCP_CREDITS_ENABLED is off", async () => {
    state.configRef = {};

    expect(await new AutumnService().coversWithMcpCredits(charge)).toBe(false);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("never asks Autumn for a partner-provisioned team", async () => {
    state.gatewayStubRow = { team_id: "team-1" };

    expect(await new AutumnService().coversWithMcpCredits(charge)).toBe(false);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("never asks Autumn for a preview team or a zero charge", async () => {
    const service = new AutumnService();

    expect(
      await service.coversWithMcpCredits({ ...charge, teamId: "preview_1" }),
    ).toBe(false);
    expect(await service.coversWithMcpCredits({ ...charge, value: 0 })).toBe(
      false,
    );
    expect(mockCheck).not.toHaveBeenCalled();
  });
});
