/**
 * Unit tests for AutumnService.
 *
 * All external I/O is mocked:
 *   - autumnClient  →  jest.fn() stubs on customers / entities / track
 *   - supabase_rr_service  →  stubbed Supabase query builder
 */

import { jest } from "@jest/globals";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import under test so Jest hoists them.
// ---------------------------------------------------------------------------

const mockTrack = jest
  .fn<(args: any) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockCheck = jest
  .fn<(args: any) => Promise<any>>()
  .mockResolvedValue({ allowed: true, customerId: "org-1", balance: null });
const mockFinalize = jest
  .fn<(args: any) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockGetOrCreate = jest
  .fn<(args: any) => Promise<unknown>>()
  .mockResolvedValue({ id: "org-1" });
const mockEntityGet = jest.fn<(args: any) => Promise<unknown>>();
const mockEntityCreate = jest.fn<(args: any) => Promise<unknown>>();

const mockAutumnClient = {
  customers: { getOrCreate: mockGetOrCreate },
  entities: { get: mockEntityGet, create: mockEntityCreate },
  balances: { finalize: mockFinalize },
  check: mockCheck,
  track: mockTrack,
};

// Mutable reference so individual tests can set it to null to simulate missing key.
let autumnClientRef: typeof mockAutumnClient | null = mockAutumnClient;

jest.mock("../client", () => ({
  get autumnClient() {
    return autumnClientRef;
  },
}));

// Minimal Supabase query-builder stub: .from().select().eq().single() → resolves data/error.
const makeSupabaseStub = (data: unknown, error: unknown = null) => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        single: () => Promise.resolve({ data, error }),
        gte: () => Promise.resolve({ data: [], error: null }),
      }),
      gte: () => Promise.resolve({ data: [], error: null }),
    }),
  }),
});

let supabaseStubData: { data: unknown; error: unknown } = {
  data: { org_id: "org-1" },
  error: null,
};

jest.mock("../../supabase", () => ({
  get supabase_rr_service() {
    return makeSupabaseStub(supabaseStubData.data, supabaseStubData.error);
  },
}));

jest.mock("../../../config", () => ({
  config: {
    AUTUMN_CHECK_ENABLED: undefined,
    AUTUMN_CHECK_DRY_RUN: undefined,
    AUTUMN_EXPERIMENT: "true",
  },
}));

// Import AFTER mocks are wired up.
import {
  AutumnService,
  BoundedMap,
  BoundedSet,
  isAutumnCheckDryRun,
  isAutumnCheckEnabled,
  isAutumnEnabled,
} from "../autumn.service";
import { config } from "../../../config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService() {
  return new AutumnService();
}

function makeEntity(usage: number) {
  return { balances: { CREDITS: { usage } } };
}

function setAutumnConfig(
  overrides: {
    AUTUMN_CHECK_ENABLED?: string;
    AUTUMN_CHECK_DRY_RUN?: string;
    AUTUMN_EXPERIMENT?: string;
  } = {},
) {
  config.AUTUMN_CHECK_ENABLED = overrides.AUTUMN_CHECK_ENABLED;
  config.AUTUMN_CHECK_DRY_RUN = overrides.AUTUMN_CHECK_DRY_RUN;
  config.AUTUMN_EXPERIMENT = overrides.AUTUMN_EXPERIMENT ?? "true";
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  autumnClientRef = mockAutumnClient;
  supabaseStubData = { data: { org_id: "org-1" }, error: null };
  setAutumnConfig({ AUTUMN_CHECK_ENABLED: undefined });
  mockCheck.mockResolvedValue({
    allowed: true,
    customerId: "org-1",
    balance: null,
  });
  mockFinalize.mockResolvedValue(undefined);
  mockEntityGet.mockResolvedValue(makeEntity(0));
  mockEntityCreate.mockResolvedValue({ id: "team-1" });
});

// ---------------------------------------------------------------------------
// BoundedMap / BoundedSet (via observable side-effects on the caches)
// ---------------------------------------------------------------------------

describe("BoundedMap eviction", () => {
  it("never exceeds its cap", () => {
    const m = new BoundedMap<number, number>(3);
    m.set(1, 1);
    m.set(2, 2);
    m.set(3, 3);
    expect(m.size).toBe(3);
    m.set(4, 4); // evicts key 1
    expect(m.size).toBe(3);
    expect(m.has(1)).toBe(false);
    expect(m.has(4)).toBe(true);
  });

  it("does not evict on update of existing key", () => {
    const m = new BoundedMap<number, number>(2);
    m.set(1, 1);
    m.set(2, 2);
    m.set(1, 99); // update, not a new entry
    expect(m.size).toBe(2);
    expect(m.get(1)).toBe(99);
    expect(m.has(2)).toBe(true);
  });
});

describe("BoundedSet eviction", () => {
  it("never exceeds its cap", () => {
    const s = new BoundedSet<number>(3);
    s.add(1);
    s.add(2);
    s.add(3);
    expect(s.size).toBe(3);
    s.add(4); // evicts value 1
    expect(s.size).toBe(3);
    expect(s.has(1)).toBe(false);
    expect(s.has(4)).toBe(true);
  });

  it("does not evict on re-add of existing value", () => {
    const s = new BoundedSet<number>(2);
    s.add(1);
    s.add(2);
    s.add(1); // already present, no eviction
    expect(s.size).toBe(2);
    expect(s.has(2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureTeamProvisioned
// ---------------------------------------------------------------------------

describe("ensureTeamProvisioned", () => {
  it("skips all HTTP calls for preview teams", async () => {
    const svc = makeService();
    await svc.ensureTeamProvisioned({ teamId: "preview_abc", orgId: "org-1" });
    expect(mockEntityGet).not.toHaveBeenCalled();
    expect(mockEntityCreate).not.toHaveBeenCalled();
  });

  it("skips getEntity when team is already in ensuredTeams cache", async () => {
    const svc = makeService();
    // First call — populates cache.
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    const callsAfterFirst = mockEntityGet.mock.calls.length;

    // Second call — should be a no-op.
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    expect(mockEntityGet.mock.calls.length).toBe(callsAfterFirst);
  });

  it("marks team as ensured without a second getEntity when entity already exists", async () => {
    const svc = makeService();
    mockEntityGet.mockResolvedValue(makeEntity(10));

    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });

    // getEntity called once (existence check), createEntity never called.
    expect(mockEntityGet).toHaveBeenCalledTimes(1);
    expect(mockEntityCreate).not.toHaveBeenCalled();

    // Second call — team is cached, zero additional HTTP calls.
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    expect(mockEntityGet).toHaveBeenCalledTimes(1);
  });

  it("marks team as ensured without a second getEntity when createEntity succeeds", async () => {
    const svc = makeService();
    // First getEntity returns null → entity doesn't exist yet.
    mockEntityGet.mockResolvedValue(null);
    mockEntityCreate.mockResolvedValue({ id: "team-1" });

    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });

    // Only one getEntity call (no confirmation get).
    expect(mockEntityGet).toHaveBeenCalledTimes(1);
    expect(mockEntityCreate).toHaveBeenCalledTimes(1);
    expect(mockEntityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "TEAM" }),
    );
  });

  it("marks team as ensured on 409 conflict without a second getEntity", async () => {
    const svc = makeService();
    mockEntityGet.mockResolvedValue(null);
    // createEntity returns null to simulate 409 — the mock throws a 409 error
    // to exercise the conflict branch inside createEntity.
    mockEntityCreate.mockRejectedValue(
      Object.assign(new Error("conflict"), { status: 409 }),
    );

    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });

    expect(mockEntityGet).toHaveBeenCalledTimes(1);
    // Team should still be marked as ensured (entity exists, just raced).
    // Verify by checking that a second provisioning call makes zero HTTP requests.
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    expect(mockEntityGet).toHaveBeenCalledTimes(1);
  });

  it("does NOT mark team as ensured when createEntity has a genuine error", async () => {
    const svc = makeService();
    mockEntityGet.mockResolvedValue(null);
    mockEntityCreate.mockRejectedValue(
      Object.assign(new Error("server error"), { status: 500 }),
    );

    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });

    // Second call must re-attempt (team not cached).
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    expect(mockEntityGet).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// ensureTrackingContext short-circuit (both caches warm)
// ---------------------------------------------------------------------------

describe("ensureTrackingContext warm-cache short-circuit", () => {
  it("makes zero provisioning HTTP calls when both caches are warm", async () => {
    const svc = makeService();
    mockEntityGet.mockResolvedValue(makeEntity(0));

    // Warm the caches.
    await svc.trackCredits({ teamId: "team-1", value: 5 });
    const callsAfterWarm = mockEntityGet.mock.calls.length;

    // Subsequent call — should not touch provisioning.
    await svc.trackCredits({ teamId: "team-1", value: 5 });

    // No additional getEntity calls for provisioning.
    expect(mockEntityGet.mock.calls.length).toBe(callsAfterWarm);
  });
});

// ---------------------------------------------------------------------------
// lockCredits
// ---------------------------------------------------------------------------

describe("lockCredits", () => {
  it("returns null when autumnClient is null", async () => {
    autumnClientRef = null;
    const svc = makeService();
    const result = await svc.lockCredits({ teamId: "team-1", value: 10 });
    expect(result).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("returns null for preview teams", async () => {
    const svc = makeService();
    const result = await svc.lockCredits({
      teamId: "preview_abc",
      value: 10,
    });
    expect(result).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("returns the lockId on happy path", async () => {
    const svc = makeService();

    const result = await svc.lockCredits({
      teamId: "team-1",
      value: 42,
      lockId: "lock-123",
      properties: { source: "billTeam", endpoint: "extract" },
    });

    expect(result).toBe("lock-123");
    expect(mockCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "org-1",
        entityId: "team-1",
        featureId: "CREDITS",
        requiredBalance: 42,
        properties: { source: "billTeam", endpoint: "extract" },
        lock: expect.objectContaining({
          enabled: true,
          lockId: "lock-123",
        }),
      }),
    );
  });

  it("returns null when Autumn denies the lock", async () => {
    mockCheck.mockResolvedValue({
      allowed: false,
      customerId: "org-1",
      balance: null,
    });
    const svc = makeService();
    const result = await svc.lockCredits({
      teamId: "team-1",
      value: 10,
      lockId: "lock-123",
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkCredits
// ---------------------------------------------------------------------------

describe("checkCredits", () => {
  it("returns null when autumnClient is null", async () => {
    autumnClientRef = null;
    config.AUTUMN_CHECK_ENABLED = "true";
    const svc = makeService();
    const result = await svc.checkCredits({ teamId: "team-1", value: 10 });
    expect(result).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("returns allowed and remaining on happy path without a lock", async () => {
    config.AUTUMN_CHECK_ENABLED = "true";
    mockCheck.mockResolvedValue({
      allowed: true,
      customerId: "org-1",
      balance: { remaining: 500 },
    });
    const svc = makeService();
    const result = await svc.checkCredits({
      teamId: "team-1",
      value: 42,
      properties: { source: "checkCreditsMiddleware" },
    });

    expect(result).toEqual({ allowed: true, remaining: 500 });
    expect(mockCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "org-1",
        entityId: "team-1",
        featureId: "CREDITS",
        requiredBalance: 42,
        properties: { source: "checkCreditsMiddleware" },
      }),
    );
    expect(mockCheck).toHaveBeenCalledWith(
      expect.not.objectContaining({ lock: expect.anything() }),
    );
  });

  it("returns allowed false with remaining 0 when balance is null", async () => {
    config.AUTUMN_CHECK_ENABLED = "true";
    mockCheck.mockResolvedValue({
      allowed: false,
      customerId: "org-1",
      balance: null,
    });
    const svc = makeService();
    const result = await svc.checkCredits({ teamId: "team-1", value: 10 });
    expect(result).toEqual({ allowed: false, remaining: 0 });
  });
});

// ---------------------------------------------------------------------------
// trackCredits
// ---------------------------------------------------------------------------

describe("trackCredits", () => {
  it("returns false when autumnClient is null", async () => {
    autumnClientRef = null;
    const svc = makeService();
    const result = await svc.trackCredits({ teamId: "team-1", value: 10 });
    expect(result).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("returns false for preview teams", async () => {
    const svc = makeService();
    const result = await svc.trackCredits({
      teamId: "preview_abc",
      value: 10,
    });
    expect(result).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("calls track with correct feature and value on happy path", async () => {
    const svc = makeService();

    const result = await svc.trackCredits({
      teamId: "team-1",
      value: 42,
      properties: { source: "test", endpoint: "extract" },
    });

    expect(result).toBe(true);
    // track should have been called for the actual usage event (at minimum).
    const trackCalls = mockTrack.mock.calls;
    const usageCall = trackCalls.find(
      (c: any[]) => c[0].featureId === "CREDITS" && c[0].value === 42,
    );
    expect(usageCall).toBeDefined();
    expect((usageCall as any[])[0].properties?.endpoint).toBe("extract");
  });

  it("returns false when the Autumn track request fails", async () => {
    mockTrack.mockRejectedValueOnce(new Error("track failed"));
    const svc = makeService();

    expect(await svc.trackCredits({ teamId: "team-1", value: 42 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// finalizeCreditsLock
// ---------------------------------------------------------------------------

describe("finalizeCreditsLock", () => {
  it("calls balances.finalize with confirm", async () => {
    const svc = makeService();
    await svc.finalizeCreditsLock({
      lockId: "lock-123",
      action: "confirm",
      properties: { source: "test" },
    });

    expect(mockFinalize).toHaveBeenCalledWith({
      lockId: "lock-123",
      action: "confirm",
      overrideValue: undefined,
      properties: { source: "test" },
    });
  });

  it("is a no-op when autumnClient is null", async () => {
    autumnClientRef = null;
    const svc = makeService();
    await svc.finalizeCreditsLock({ lockId: "lock-123", action: "release" });
    expect(mockFinalize).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// refundCredits
// ---------------------------------------------------------------------------

describe("refundCredits", () => {
  it("calls track with the negated value", async () => {
    const svc = makeService();
    await svc.refundCredits({
      teamId: "team-1",
      value: 30,
      properties: { endpoint: "extract" },
    });

    const refundCall = mockTrack.mock.calls.find(
      (c: any[]) => c[0].value === -30,
    );
    expect(refundCall).toBeDefined();
    expect((refundCall as any[])[0].properties?.source).toBe("autumn_refund");
    expect((refundCall as any[])[0].properties?.endpoint).toBe("extract");
  });

  it("is a no-op when autumnClient is null", async () => {
    autumnClientRef = null;
    const svc = makeService();
    await svc.refundCredits({ teamId: "team-1", value: 30 });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("is a no-op for preview teams", async () => {
    const svc = makeService();
    await svc.refundCredits({ teamId: "preview_abc", value: 30 });
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isAutumnEnabled / experiment gating
// ---------------------------------------------------------------------------

describe("isAutumnEnabled", () => {
  afterEach(() => {
    setAutumnConfig();
  });

  it("returns true when AUTUMN_EXPERIMENT is 'true'", () => {
    expect(isAutumnEnabled()).toBe(true);
  });

  it("returns false when AUTUMN_EXPERIMENT is not 'true'", () => {
    config.AUTUMN_EXPERIMENT = undefined;
    expect(isAutumnEnabled()).toBe(false);
  });
});

describe("isAutumnCheckEnabled", () => {
  afterEach(() => {
    setAutumnConfig({ AUTUMN_CHECK_ENABLED: undefined });
  });

  it("returns false when AUTUMN_CHECK_ENABLED is not 'true'", () => {
    config.AUTUMN_CHECK_ENABLED = undefined;
    expect(isAutumnCheckEnabled()).toBe(false);
  });

  it("returns false when Autumn experiment is disabled", () => {
    config.AUTUMN_CHECK_ENABLED = "true";
    config.AUTUMN_EXPERIMENT = undefined;
    expect(isAutumnCheckEnabled()).toBe(false);
  });

  it("returns true only when both check flag and experiment are enabled", () => {
    config.AUTUMN_CHECK_ENABLED = "true";
    expect(isAutumnCheckEnabled()).toBe(true);
  });
});

describe("isAutumnCheckDryRun", () => {
  afterEach(() => {
    config.AUTUMN_CHECK_DRY_RUN = undefined;
  });

  it("returns false when AUTUMN_CHECK_DRY_RUN is not set", () => {
    config.AUTUMN_CHECK_DRY_RUN = undefined;
    expect(isAutumnCheckDryRun()).toBe(false);
  });

  it("returns false when AUTUMN_CHECK_DRY_RUN is not 'true'", () => {
    config.AUTUMN_CHECK_DRY_RUN = "false";
    expect(isAutumnCheckDryRun()).toBe(false);
  });

  it("returns true when AUTUMN_CHECK_DRY_RUN is 'true'", () => {
    config.AUTUMN_CHECK_DRY_RUN = "true";
    expect(isAutumnCheckDryRun()).toBe(true);
  });
});

describe("experiment gate on lockCredits", () => {
  afterEach(() => {
    setAutumnConfig();
  });

  it("lockCredits returns null when experiment is disabled", async () => {
    config.AUTUMN_EXPERIMENT = undefined;
    const svc = makeService();
    const result = await svc.lockCredits({ teamId: "team-1", value: 10 });
    expect(result).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("refundCredits still works when experiment is disabled (guard is autumnReserved)", async () => {
    config.AUTUMN_EXPERIMENT = undefined;
    const svc = makeService();
    // Warm the caches so refund can resolve the tracking context.
    config.AUTUMN_EXPERIMENT = "true";
    await svc.trackCredits({ teamId: "team-1", value: 10 });
    jest.clearAllMocks();

    // Disable experiment — refund must still succeed to avoid orphaned credits.
    config.AUTUMN_EXPERIMENT = undefined;
    mockTrack.mockResolvedValue(undefined);
    await svc.refundCredits({ teamId: "team-1", value: 10 });
    expect(mockTrack).toHaveBeenCalled();
  });

  it("ensureTeamProvisioned still works when experiment is disabled (handled by firecrawl-web)", async () => {
    config.AUTUMN_EXPERIMENT = undefined;
    const svc = makeService();
    await svc.ensureTeamProvisioned({ teamId: "team-1", orgId: "org-1" });
    // Provisioning should proceed — firecrawl-web edge functions do this
    // regardless, so gating API-side provisioning is unnecessary.
    expect(mockGetOrCreate).toHaveBeenCalled();
  });
});
