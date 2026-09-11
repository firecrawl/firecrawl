/**
 * The org comes from the caller, and nowhere else: AutumnService must have no
 * way to look one up. controllers/auth is mocked with a factory that throws, so
 * a service that reaches for the ACUC again — directly or through a helper —
 * fails this file at import time rather than quietly resolving its own org.
 */

import { vi } from "vitest";

const { mockCheck, mockTrack, mockAutumnClient } = vi.hoisted(() => {
  const mockCheck = vi
    .fn<(args: any) => Promise<any>>()
    .mockResolvedValue({ allowed: true, customerId: "org-1", balance: null });
  const mockTrack = vi
    .fn<(args: any) => Promise<void>>()
    .mockResolvedValue(undefined);
  return {
    mockCheck,
    mockTrack,
    mockAutumnClient: {
      customers: { getOrCreate: vi.fn().mockResolvedValue({ id: "org-1" }) },
      entities: {
        get: vi.fn().mockResolvedValue({ balances: { CREDITS: { usage: 0 } } }),
        create: vi.fn().mockResolvedValue({ id: "team-1" }),
      },
      balances: { finalize: vi.fn().mockResolvedValue(undefined) },
      check: mockCheck,
      track: mockTrack,
    },
  };
});

// The seam: importing this module at all is the failure.
vi.mock("../../../controllers/auth", () => {
  throw new Error("autumn.service must not import controllers/auth");
});

vi.mock("../client", () => ({
  autumnClient: mockAutumnClient,
}));

vi.mock("../../../db/connection", () => ({
  dbRr: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  },
}));

vi.mock("../../../config", () => ({
  // Stubbed so importing the real config (which parses env) is avoided.
  config: {},
}));

// Import AFTER the mocks are wired up.
import { AutumnService } from "../autumn.service";

const CALLER_ORG = "3f2c1b8e-7a4d-4c1e-9b6a-0d5e8f2a1c74";

describe("AutumnService resolves no org of its own", () => {
  it("checks credits against the org the caller handed in", async () => {
    const result = await new AutumnService().checkCredits({
      teamId: "team-1",
      orgId: CALLER_ORG,
      value: 42,
    });

    expect(result).toEqual({ allowed: true, remaining: 0 });
    expect(mockCheck).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CALLER_ORG, entityId: "team-1" }),
    );
  });

  it("tracks credits against the org the caller handed in", async () => {
    await new AutumnService().trackCredits({
      teamId: "team-1",
      orgId: CALLER_ORG,
      value: 7,
    });

    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CALLER_ORG, entityId: "team-1" }),
    );
  });
});
