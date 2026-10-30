/**
 * Unit tests for hosted MCP charges in AutumnService: a hosted charge is
 * tracked whole on MCP credits at the customer level, and Autumn decides which
 * balances pay for it.
 */

import { vi } from "vitest";

const { mockCheck, mockTrack, mockAutumnClient, state } = vi.hoisted(() => {
  const mockCheck = vi.fn<(args: any) => Promise<any>>();
  const mockTrack = vi.fn<(args: any) => Promise<any>>();
  const mockAutumnClient = {
    customers: { getOrCreate: vi.fn(), get: vi.fn() },
    entities: {
      get: vi.fn().mockResolvedValue({ id: "team-1" }),
      create: vi.fn(),
    },
    balances: { finalize: vi.fn() },
    check: mockCheck,
    track: mockTrack,
  };
  return { mockCheck, mockTrack, mockAutumnClient, state: { firebill: false } };
});

vi.mock("../client", () => ({
  autumnClient: mockAutumnClient,
}));

vi.mock("../../queue-service", () => ({
  getFirebillTrackRetryQueue: () => ({ add: vi.fn() }),
}));

vi.mock("../../../db/connection", () => ({
  dbRr: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  },
}));

vi.mock("../../../config", () => ({
  get config() {
    return {
      MCP_CREDITS_FEATURE_ID: "MCP_CREDITS_FROM_CONFIG",
      ...(state.firebill
        ? {
            FIREBILL_URL: "http://firebill.test",
            FIREBILL_SECRET: "fb-secret",
            FIREBILL_ORG_IDS: ["org-1"],
          }
        : {}),
    };
  },
}));

import { AutumnService, MCP_CREDITS_FEATURE_ID } from "../autumn.service";

const charge = {
  teamId: "team-1",
  orgId: "org-1",
  value: 5,
  properties: { source: "billTeam", endpoint: "search" },
  featureId: "SEARCH_CREDITS",
  idempotencyKey: "fc:track:search:job-1",
};

const deducted = (...deductions: [string, number][]) =>
  mockTrack.mockResolvedValue({
    deductions: deductions.map(([featureId, value]) => ({ featureId, value })),
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.firebill = false;
  mockTrack.mockResolvedValue({});
  mockCheck.mockResolvedValue({ allowed: true, balance: { remaining: 100 } });
});

it("reads the feature id from config", () => {
  expect(MCP_CREDITS_FEATURE_ID).toBe("MCP_CREDITS_FROM_CONFIG");
});

describe("trackHostedMcpCredits", () => {
  it("tracks the whole charge once on MCP credits, on the customer", async () => {
    deducted([MCP_CREDITS_FEATURE_ID, 5]);

    expect(await new AutumnService().trackHostedMcpCredits(charge)).toEqual({
      tracked: true,
      mcpCredits: 5,
    });

    expect(mockTrack).toHaveBeenCalledOnce();
    const [track] = mockTrack.mock.calls[0];
    expect(track).toMatchObject({
      customerId: "org-1",
      featureId: MCP_CREDITS_FEATURE_ID,
      value: 5,
      overageBehavior: "overflow",
    });
    expect(track.entityId).toBeUndefined();
    expect(mockAutumnClient.customers.get).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("counts as MCP credits only what Autumn deducted from them", async () => {
    deducted([MCP_CREDITS_FEATURE_ID, 3], ["CREDITS", 2]);

    expect(await new AutumnService().trackHostedMcpCredits(charge)).toEqual({
      tracked: true,
      mcpCredits: 3,
    });
    expect(mockTrack).toHaveBeenCalledOnce();
  });

  it("counts no MCP credits when Autumn reports no deductions", async () => {
    expect(await new AutumnService().trackHostedMcpCredits(charge)).toEqual({
      tracked: true,
      mcpCredits: 0,
    });
  });

  it("reports an untracked charge as untracked", async () => {
    mockTrack.mockRejectedValue(new Error("track failed"));

    expect(await new AutumnService().trackHostedMcpCredits(charge)).toEqual({
      tracked: false,
      mcpCredits: 0,
    });
  });
});

describe("the entity a charge is made against", () => {
  it("refunds MCP credits on the customer and other features on the team", async () => {
    const service = new AutumnService();

    await service.refundCredits({
      ...charge,
      featureId: MCP_CREDITS_FEATURE_ID,
    });
    await service.refundCredits(charge);

    const [[mcp], [search]] = mockTrack.mock.calls;
    expect(mcp).toMatchObject({ featureId: MCP_CREDITS_FEATURE_ID, value: -5 });
    expect(mcp.entityId).toBeUndefined();
    expect(search).toMatchObject({
      featureId: "SEARCH_CREDITS",
      entityId: "team-1",
      value: -5,
    });
  });

  it("checks and holds MCP credits on the customer and other features on the team", async () => {
    const service = new AutumnService();

    await service.checkCredits({
      ...charge,
      featureId: MCP_CREDITS_FEATURE_ID,
    });
    await service.lockCredits({ ...charge, featureId: MCP_CREDITS_FEATURE_ID });
    await service.checkCredits(charge);

    const [[check], [hold], [search]] = mockCheck.mock.calls;
    expect(check.entityId).toBeUndefined();
    expect(hold).toMatchObject({
      featureId: MCP_CREDITS_FEATURE_ID,
      lock: expect.objectContaining({ enabled: true }),
    });
    expect(hold.entityId).toBeUndefined();
    expect(search).toMatchObject({
      featureId: "SEARCH_CREDITS",
      entityId: "team-1",
    });
  });

  describe("through firebill", () => {
    const mockFetch = vi.fn<(url: any, init?: any) => Promise<Response>>();
    const bodies = (path: string) =>
      mockFetch.mock.calls
        .filter(([url]) => String(url).endsWith(path))
        .map(([, init]) => JSON.parse(init.body));

    beforeEach(() => {
      state.firebill = true;
      mockFetch.mockReset();
      vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("tracks a hosted charge whole with an empty entity", async () => {
      mockFetch.mockImplementation(
        async () => new Response(JSON.stringify({ success: true })),
      );

      expect(await new AutumnService().trackHostedMcpCredits(charge)).toEqual({
        tracked: true,
        mcpCredits: 0,
      });

      expect(mockTrack).not.toHaveBeenCalled();
      expect(bodies("/v1/track")).toEqual([
        expect.objectContaining({
          customer_id: "org-1",
          entity_id: "",
          feature_id: MCP_CREDITS_FEATURE_ID,
          value: 5,
        }),
      ]);
    });

    it("checks and holds MCP credits with an empty entity", async () => {
      mockFetch.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              allowed: true,
              remaining: 100,
              lock_id: "lock-1",
            }),
          ),
      );
      const service = new AutumnService();

      await service.checkCredits({
        ...charge,
        featureId: MCP_CREDITS_FEATURE_ID,
      });
      await service.lockCredits({
        ...charge,
        featureId: MCP_CREDITS_FEATURE_ID,
        lockId: "lock-1",
      });

      expect(mockCheck).not.toHaveBeenCalled();
      expect(bodies("/v1/check")).toEqual([
        expect.objectContaining({
          entity_id: "",
          feature_id: MCP_CREDITS_FEATURE_ID,
        }),
      ]);
      expect(bodies("/v1/lock")).toEqual([
        expect.objectContaining({
          entity_id: "",
          feature_id: MCP_CREDITS_FEATURE_ID,
        }),
      ]);
    });
  });
});
