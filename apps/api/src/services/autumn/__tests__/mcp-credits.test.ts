/**
 * Unit tests for hosted MCP charges in AutumnService: how much the team's MCP
 * credits can pay (mcpCreditsAvailable), and how a charge is split between
 * them and the endpoint's own feature (trackHostedMcpCredits).
 */

import { vi } from "vitest";

const { mockCheck, mockTrack, mockAutumnClient, state, redis } = vi.hoisted(
  () => {
    const store = new Map<string, string>();
    const redis = {
      store,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown, ...args: unknown[]) => {
        if (args.includes("NX") && store.has(key)) return null;
        store.set(key, String(value));
        return "OK";
      }),
    };
    const mockCheck = vi.fn<(args: any) => Promise<any>>();
    const mockTrack = vi.fn<(args: any) => Promise<void>>();
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
      state: { gatewayStubRow: null as unknown },
      redis,
    };
  },
);

vi.mock("../client", () => ({
  autumnClient: mockAutumnClient,
}));

vi.mock("../../queue-service", () => ({
  getFirebillTrackRetryQueue: () => ({ add: vi.fn() }),
  getRedisConnection: () => redis,
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
  config: { MCP_CREDITS_FEATURE_ID: "MCP_CREDITS_FROM_CONFIG" },
}));

import { AutumnService, MCP_CREDITS_FEATURE_ID } from "../autumn.service";

const charge = {
  teamId: "team-1",
  orgId: "org-1",
  value: 5,
  properties: { source: "billTeam", endpoint: "scrape" },
  featureId: "CREDITS",
  idempotencyKey: "fc:track:scrape:job-1",
  externalRequestId: "op-1",
};

/** MCP credits balance as Autumn's check reports it. */
function mcpBalance(remaining: number | null) {
  mockCheck.mockImplementation(async ({ featureId, requiredBalance }) => ({
    allowed:
      featureId === MCP_CREDITS_FEATURE_ID &&
      remaining !== null &&
      remaining >= requiredBalance,
    customerId: "org-1",
    balance: remaining === null ? null : { remaining },
  }));
}

/** The Autumn track calls a run of fn makes. */
async function tracksOf(fn: (service: AutumnService) => Promise<unknown>) {
  mockTrack.mockClear();
  await fn(new AutumnService());
  return mockTrack.mock.calls.map(([args]) => args);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.gatewayStubRow = null;
  redis.store.clear();
  mockTrack.mockResolvedValue(undefined);
  mcpBalance(100);
});

describe("mcpCreditsAvailable", () => {
  it("reads the feature id from config", () => {
    expect(MCP_CREDITS_FEATURE_ID).toBe("MCP_CREDITS_FROM_CONFIG");
  });

  it("pays the whole charge when the MCP credits cover it", async () => {
    expect(await new AutumnService().mcpCreditsAvailable(charge)).toBe(5);
    expect(mockCheck).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        customerId: "org-1",
        entityId: "team-1",
        featureId: MCP_CREDITS_FEATURE_ID,
        requiredBalance: 5,
      }),
    );
  });

  it("pays what is left when the MCP credits fall short", async () => {
    mcpBalance(3.5);
    expect(await new AutumnService().mcpCreditsAvailable(charge)).toBe(3);
  });

  it.each([
    ["used up", 0],
    ["missing from the team's plan", null],
  ])("pays nothing when the MCP credits are %s", async (_name, remaining) => {
    mcpBalance(remaining);
    expect(await new AutumnService().mcpCreditsAvailable(charge)).toBe(0);
  });

  it("pays nothing when Autumn can't answer", async () => {
    mockCheck.mockRejectedValue(new Error("ECONNRESET"));
    expect(await new AutumnService().mcpCreditsAvailable(charge)).toBe(0);
  });

  it("never asks Autumn for a partner-provisioned or preview team, or a zero charge", async () => {
    const service = new AutumnService();
    state.gatewayStubRow = { team_id: "team-1" };
    expect(await service.mcpCreditsAvailable(charge)).toBe(0);
    state.gatewayStubRow = null;
    expect(
      await service.mcpCreditsAvailable({ ...charge, teamId: "preview_1" }),
    ).toBe(0);
    expect(await service.mcpCreditsAvailable({ ...charge, value: 0 })).toBe(0);
    expect(mockCheck).not.toHaveBeenCalled();
  });
});

describe("trackHostedMcpCredits", () => {
  it("tracks the whole charge on MCP credits that cover it", async () => {
    const tracks = await tracksOf(service =>
      service
        .trackHostedMcpCredits(charge)
        .then(result =>
          expect(result).toEqual({ tracked: true, mcpCredits: 5 }),
        ),
    );

    expect(tracks).toEqual([
      expect.objectContaining({
        featureId: MCP_CREDITS_FEATURE_ID,
        value: 5,
        properties: charge.properties,
      }),
    ]);
  });

  it("splits a charge the MCP credits only partly cover", async () => {
    mcpBalance(3);

    const tracks = await tracksOf(service =>
      service
        .trackHostedMcpCredits(charge)
        .then(result =>
          expect(result).toEqual({ tracked: true, mcpCredits: 3 }),
        ),
    );

    expect(tracks).toHaveLength(2);
    expect(tracks).toContainEqual(
      expect.objectContaining({ featureId: MCP_CREDITS_FEATURE_ID, value: 3 }),
    );
    expect(tracks).toContainEqual(
      expect.objectContaining({
        featureId: "CREDITS",
        value: 2,
        overageBehavior: "overflow",
      }),
    );
  });

  it("gives the MCP part its own firebill idempotency key", async () => {
    mcpBalance(3);
    const service = new AutumnService();
    const trackCredits = vi.spyOn(service, "trackCredits");

    await service.trackHostedMcpCredits(charge);

    expect(trackCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: MCP_CREDITS_FEATURE_ID,
        idempotencyKey: "fc:track:scrape:job-1:mcp",
      }),
    );
    expect(trackCredits).toHaveBeenCalledWith({ ...charge, value: 2 });
  });

  it.each([
    ["used up", 0],
    ["missing from the team's plan", null],
  ])(
    "tracks exactly what trackCredits would when the MCP credits are %s",
    async (_name, remaining) => {
      mcpBalance(remaining);

      const hostedMcp = await tracksOf(service =>
        service
          .trackHostedMcpCredits(charge)
          .then(result =>
            expect(result).toEqual({ tracked: true, mcpCredits: 0 }),
          ),
      );
      const regular = await tracksOf(service => service.trackCredits(charge));

      expect(hostedMcp).toEqual(regular);
      expect(hostedMcp).toEqual([
        expect.objectContaining({ featureId: "CREDITS", value: 5 }),
      ]);
    },
  );

  it("reports an untracked MCP part as not paid by MCP credits", async () => {
    mcpBalance(3);
    mockTrack.mockImplementation(async ({ featureId }) => {
      if (featureId === MCP_CREDITS_FEATURE_ID) throw new Error("track failed");
    });

    expect(await new AutumnService().trackHostedMcpCredits(charge)).toEqual({
      tracked: false,
      mcpCredits: 0,
    });
  });
});

describe("refundHostedMcpCredits", () => {
  const refund = { ...charge, idempotencyKey: "fc:refund:scrape:job-1" };

  it("refunds each part of a split charge to the balance it was tracked on", async () => {
    const service = new AutumnService();
    const refundCredits = vi.spyOn(service, "refundCredits");

    expect(
      await service.refundHostedMcpCredits({ ...refund, mcpCredits: 3 }),
    ).toBe(true);

    expect(refundCredits).toHaveBeenCalledTimes(2);
    expect(refundCredits).toHaveBeenCalledWith({
      ...refund,
      value: 3,
      featureId: MCP_CREDITS_FEATURE_ID,
      idempotencyKey: "fc:refund:scrape:job-1:mcp",
    });
    expect(refundCredits).toHaveBeenCalledWith({ ...refund, value: 2 });
  });

  it("refunds a charge MCP credits paid in full to them only", async () => {
    const service = new AutumnService();
    const refundCredits = vi.spyOn(service, "refundCredits");

    await service.refundHostedMcpCredits({ ...refund, mcpCredits: 5 });

    expect(refundCredits).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ value: 5, featureId: MCP_CREDITS_FEATURE_ID }),
    );
  });

  it("refunds exactly as refundCredits would when MCP credits paid nothing", async () => {
    const service = new AutumnService();
    const refundCredits = vi.spyOn(service, "refundCredits");

    await service.refundHostedMcpCredits({ ...refund, mcpCredits: 0 });

    expect(refundCredits).toHaveBeenCalledExactlyOnceWith(refund);
  });
});

describe("hosted MCP charge retries", () => {
  it("splits a retried charge as the first attempt did, after it used the MCP credits up", async () => {
    mcpBalance(5);
    const first = await tracksOf(service =>
      service.trackHostedMcpCredits(charge),
    );
    mcpBalance(0);
    const retry = await tracksOf(service =>
      service
        .trackHostedMcpCredits(charge)
        .then(result =>
          expect(result).toEqual({ tracked: true, mcpCredits: 5 }),
        ),
    );

    expect(retry).toEqual(first);
    expect(retry).toEqual([
      expect.objectContaining({ featureId: MCP_CREDITS_FEATURE_ID, value: 5 }),
    ]);
  });

  it("records the allocation once, for 7 days, under the charge's key", async () => {
    mcpBalance(3);

    await new AutumnService().trackHostedMcpCredits(charge);

    expect(redis.set).toHaveBeenCalledExactlyOnceWith(
      "fc:mcp-credits:allocation:fc:track:scrape:job-1",
      3,
      "EX",
      7 * 24 * 60 * 60,
      "NX",
    );
  });

  it("works the split out afresh for a charge without a key", async () => {
    mcpBalance(3);

    await new AutumnService().trackHostedMcpCredits({
      ...charge,
      idempotencyKey: undefined,
    });

    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("works the split out afresh when Redis hangs", async () => {
    vi.useFakeTimers();
    try {
      mcpBalance(3);
      redis.get.mockReturnValueOnce(new Promise<string | null>(() => {}));

      const result = new AutumnService().trackHostedMcpCredits(charge);
      await vi.advanceTimersByTimeAsync(1000);

      expect(await result).toEqual({ tracked: true, mcpCredits: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("works the split out afresh when Redis can't answer", async () => {
    mcpBalance(3);
    redis.get.mockRejectedValueOnce(new Error("redis down"));

    expect(await new AutumnService().trackHostedMcpCredits(charge)).toEqual({
      tracked: true,
      mcpCredits: 3,
    });
  });
});
