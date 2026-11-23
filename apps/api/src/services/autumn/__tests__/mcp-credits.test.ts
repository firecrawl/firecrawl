/**
 * Unit tests for hosted MCP charges in AutumnService: a hosted charge is made
 * whole on MCP credits at the customer level, and Autumn decides which
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
  return {
    mockCheck,
    mockTrack,
    mockAutumnClient,
    state: { firebill: false, gateway: false },
  };
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
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(state.gateway ? [{ team_id: "team-1" }] : []),
        }),
      }),
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

beforeEach(() => {
  vi.clearAllMocks();
  state.firebill = false;
  state.gateway = false;
  mockTrack.mockResolvedValue({});
  mockCheck.mockResolvedValue({ allowed: true, balance: { remaining: 100 } });
});

it("reads the feature id from config", () => {
  expect(MCP_CREDITS_FEATURE_ID).toBe("MCP_CREDITS_FROM_CONFIG");
});

describe("hostedMcpFeatureId", () => {
  it("makes a hosted MCP charge on MCP credits", async () => {
    expect(
      await new AutumnService().hostedMcpFeatureId("team-1", "SEARCH_CREDITS"),
    ).toBe(MCP_CREDITS_FEATURE_ID);
  });

  it("keeps a partner-provisioned team's hosted charge on its own feature", async () => {
    state.gateway = true;

    expect(
      await new AutumnService().hostedMcpFeatureId("team-1", "SEARCH_CREDITS"),
    ).toBe("SEARCH_CREDITS");
  });
});

describe("the entity a charge is made against", () => {
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

    it("tracks an MCP credits charge with an empty entity", async () => {
      mockFetch.mockImplementation(
        async () => new Response(JSON.stringify({ success: true })),
      );

      expect(
        await new AutumnService().trackCredits({
          ...charge,
          featureId: MCP_CREDITS_FEATURE_ID,
        }),
      ).toBe(true);

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

    // MCP credits are held against the customer, not a team, so a confirm
    // says so with an empty entity rather than leaving it unknown.
    it("confirms an MCP credits hold with an empty entity", async () => {
      mockFetch.mockImplementation(
        async () => new Response(JSON.stringify({ success: true })),
      );

      await new AutumnService().finalizeCreditsLock({
        lockId: "mcp_lock-1",
        action: "confirm",
        overrideValue: 7,
        team: { teamId: "team-1", orgId: "org-1" },
        featureId: MCP_CREDITS_FEATURE_ID,
        heldValue: 5,
      });

      expect(bodies("/v1/finalize")).toEqual([
        expect.objectContaining({
          customer_id: "org-1",
          entity_id: "",
          feature_id: MCP_CREDITS_FEATURE_ID,
          held_value: 5,
        }),
      ]);
    });

    it("refunds MCP credits with an empty entity and other features on the team", async () => {
      mockFetch.mockImplementation(
        async () => new Response(JSON.stringify({ success: true })),
      );
      const service = new AutumnService();

      await service.refundCredits({
        ...charge,
        featureId: MCP_CREDITS_FEATURE_ID,
      });
      await service.refundCredits(charge);

      expect(mockTrack).not.toHaveBeenCalled();
      expect(bodies("/v1/refund")).toEqual([
        expect.objectContaining({
          entity_id: "",
          feature_id: MCP_CREDITS_FEATURE_ID,
          value: 5,
        }),
        expect.objectContaining({
          entity_id: "team-1",
          feature_id: "SEARCH_CREDITS",
          value: 5,
        }),
      ]);
    });

    it("carries the MCP allowance's reset time from firebill", async () => {
      mockFetch.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              allowed: false,
              remaining: 0,
              resets_at: 1_798_848_000_000,
            }),
          ),
      );

      const result = await new AutumnService().checkCredits({
        ...charge,
        featureId: MCP_CREDITS_FEATURE_ID,
      });

      expect(result).toEqual(
        expect.objectContaining({
          allowed: false,
          resetsAt: 1_798_848_000_000,
        }),
      );
    });

    it("checks and holds MCP credits with an empty entity and other features on the team", async () => {
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
      await service.checkCredits(charge);

      expect(mockCheck).not.toHaveBeenCalled();
      expect(bodies("/v1/check")).toEqual([
        expect.objectContaining({
          entity_id: "",
          feature_id: MCP_CREDITS_FEATURE_ID,
        }),
        expect.objectContaining({
          entity_id: "team-1",
          feature_id: "SEARCH_CREDITS",
        }),
      ]);
      expect(bodies("/v1/lock")).toEqual([
        expect.objectContaining({
          entity_id: "",
          feature_id: MCP_CREDITS_FEATURE_ID,
        }),
      ]);
    });

    // An MCP charge has no entity, so its properties are the only place that
    // says which team made it.
    it("names the team in the properties of every call, with or without an entity", async () => {
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
      const mcp = { ...charge, featureId: MCP_CREDITS_FEATURE_ID };

      for (const params of [mcp, charge]) {
        await service.checkCredits(params);
        await service.lockCredits({ ...params, lockId: "lock-1" });
        await service.trackCredits(params);
        await service.refundCredits(params);
      }

      const named = (entityId: string, featureId: string, source?: string) =>
        expect.objectContaining({
          entity_id: entityId,
          feature_id: featureId,
          properties: {
            ...charge.properties,
            ...(source ? { source } : {}),
            teamId: "team-1",
          },
        });
      for (const path of ["/v1/check", "/v1/lock", "/v1/track"]) {
        expect(bodies(path)).toEqual([
          named("", MCP_CREDITS_FEATURE_ID),
          named("team-1", "SEARCH_CREDITS"),
        ]);
      }
      expect(bodies("/v1/refund")).toEqual([
        named("", MCP_CREDITS_FEATURE_ID, "autumn_refund"),
        named("team-1", "SEARCH_CREDITS", "autumn_refund"),
      ]);
    });

    it("keeps the billed team over a teamId the caller passed", async () => {
      mockFetch.mockImplementation(
        async () => new Response(JSON.stringify({ success: true })),
      );

      await new AutumnService().trackCredits({
        ...charge,
        featureId: MCP_CREDITS_FEATURE_ID,
        properties: { ...charge.properties, teamId: "someone-else" },
      });

      expect(bodies("/v1/track")[0].properties.teamId).toBe("team-1");
    });

    it("names the team on a settle that knows it", async () => {
      mockFetch.mockImplementation(
        async () => new Response(JSON.stringify({ success: true })),
      );

      await new AutumnService().finalizeCreditsLock({
        lockId: "lock-1",
        action: "confirm",
        overrideValue: 3,
        properties: { source: "alexandria", endpoint: "scrape" },
        team: { teamId: "team-1", orgId: "org-1" },
        featureId: MCP_CREDITS_FEATURE_ID,
      });

      expect(bodies("/v1/finalize")).toEqual([
        expect.objectContaining({
          properties: {
            source: "alexandria",
            endpoint: "scrape",
            teamId: "team-1",
          },
        }),
      ]);
    });
  });
});
