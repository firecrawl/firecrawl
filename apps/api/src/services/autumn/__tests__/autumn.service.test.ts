/**
 * Unit tests for AutumnService.
 *
 * All external I/O is mocked:
 *   - autumnClient  →  vi.fn() stubs on customers / entities / track
 *   - dbRr          →  stubbed Drizzle query builder
 */

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — vi.mock is hoisted above the module body, so the mock backing objects
// and the mutable state the factories read must live in vi.hoisted() too.
// ---------------------------------------------------------------------------

const {
  mockTrack,
  mockCheck,
  mockFinalize,
  mockGetOrCreate,
  mockEntityGet,
  mockEntityCreate,
  mockAutumnClient,
  makeDbStub,
  state,
} = vi.hoisted(() => {
  const mockTrack = vi
    .fn<(args: any) => Promise<void>>()
    .mockResolvedValue(undefined);
  const mockCheck = vi
    .fn<(args: any) => Promise<any>>()
    .mockResolvedValue({ allowed: true, customerId: "org-1", balance: null });
  const mockFinalize = vi
    .fn<(args: any) => Promise<void>>()
    .mockResolvedValue(undefined);
  const mockGetOrCreate = vi
    .fn<(args: any) => Promise<unknown>>()
    .mockResolvedValue({ id: "org-1" });
  const mockEntityGet = vi.fn<(args: any) => Promise<unknown>>();
  const mockEntityCreate = vi.fn<(args: any) => Promise<unknown>>();

  const mockAutumnClient = {
    customers: { getOrCreate: mockGetOrCreate },
    entities: { get: mockEntityGet, create: mockEntityCreate },
    balances: { finalize: mockFinalize },
    check: mockCheck,
    track: mockTrack,
  };

  // Minimal Drizzle query-builder stub: .select().from().where().limit() → rows.
  const makeDbStub = (data: unknown) => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(data ? [data] : []),
        }),
      }),
    }),
  });

  return {
    mockTrack,
    mockCheck,
    mockFinalize,
    mockGetOrCreate,
    mockEntityGet,
    mockEntityCreate,
    mockAutumnClient,
    makeDbStub,
    // Mutable state individual tests tweak (e.g. set state.autumnClientRef = null to
    // simulate a missing API key).
    state: {
      autumnClientRef: mockAutumnClient as typeof mockAutumnClient | null,
      supabaseStubData: { data: { org_id: "org-1" }, error: null } as {
        data: unknown;
        error: unknown;
      },
      configRef: {} as Record<string, unknown>,
    },
  };
});

vi.mock("../client", () => ({
  get autumnClient() {
    return state.autumnClientRef;
  },
}));

vi.mock("../../../db/connection", () => ({
  get dbRr() {
    return makeDbStub(state.supabaseStubData.data);
  },
}));

vi.mock("../../../config", () => ({
  // Stubbed so importing the real config (which parses env) is avoided.
  // A getter so individual tests can swap the config (e.g. firebill routing).
  get config() {
    return state.configRef;
  },
}));

// Import AFTER mocks are wired up.
import {
  AutumnService,
  BoundedMap,
  BoundedSet,
  featureIdForBillingEndpoint,
} from "../autumn.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService() {
  return new AutumnService();
}

function makeEntity(usage: number) {
  return { balances: { CREDITS: { usage } } };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  state.autumnClientRef = mockAutumnClient;
  state.supabaseStubData = { data: { org_id: "org-1" }, error: null };
  state.configRef = {};
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
  it("returns skipped when autumnClient is null", async () => {
    state.autumnClientRef = null;
    const svc = makeService();
    const result = await svc.lockCredits({ teamId: "team-1", value: 10 });
    expect(result).toEqual({ status: "skipped" });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("returns skipped for preview teams", async () => {
    const svc = makeService();
    const result = await svc.lockCredits({
      teamId: "preview_abc",
      value: 10,
    });
    expect(result).toEqual({ status: "skipped" });
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

    expect(result).toEqual({ status: "locked", lockId: "lock-123" });
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

  it("returns denied when Autumn denies the lock", async () => {
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
    expect(result).toEqual({ status: "denied" });
  });

  it("returns skipped when the billing API throws (fallback)", async () => {
    mockCheck.mockRejectedValue(new Error("autumn down"));
    const svc = makeService();
    const result = await svc.lockCredits({
      teamId: "team-1",
      value: 10,
      lockId: "lock-123",
    });
    expect(result).toEqual({ status: "skipped" });
  });
});

// ---------------------------------------------------------------------------
// checkCredits
// ---------------------------------------------------------------------------

describe("checkCredits", () => {
  it("returns null when autumnClient is null", async () => {
    state.autumnClientRef = null;
    const svc = makeService();
    const result = await svc.checkCredits({ teamId: "team-1", value: 10 });
    expect(result).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("returns allowed and remaining on happy path without a lock", async () => {
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
    mockCheck.mockResolvedValue({
      allowed: false,
      customerId: "org-1",
      balance: null,
    });
    const svc = makeService();
    const result = await svc.checkCredits({ teamId: "team-1", value: 10 });
    expect(result).toEqual({ allowed: false, remaining: 0 });
  });

  it("checks against SEARCH_CREDITS when featureId is provided", async () => {
    const svc = makeService();
    await svc.checkCredits({
      teamId: "team-1",
      value: 5,
      featureId: "SEARCH_CREDITS",
    });
    expect(mockCheck).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "SEARCH_CREDITS" }),
    );
  });
});

// ---------------------------------------------------------------------------
// trackCredits
// ---------------------------------------------------------------------------

describe("trackCredits", () => {
  it("returns false when autumnClient is null", async () => {
    state.autumnClientRef = null;
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
    expect((usageCall as any[])[0].overageBehavior).toBe("overflow");
  });

  it("returns false when the Autumn track request fails", async () => {
    mockTrack.mockRejectedValueOnce(new Error("track failed"));
    const svc = makeService();

    expect(await svc.trackCredits({ teamId: "team-1", value: 42 })).toBe(false);
  });

  it("tracks against SEARCH_CREDITS when featureId is provided", async () => {
    const svc = makeService();

    const result = await svc.trackCredits({
      teamId: "team-1",
      value: 7,
      properties: { source: "test", endpoint: "search" },
      featureId: "SEARCH_CREDITS",
    });

    expect(result).toBe(true);
    const usageCall = mockTrack.mock.calls.find((c: any[]) => c[0].value === 7);
    expect(usageCall).toBeDefined();
    expect((usageCall as any[])[0].featureId).toBe("SEARCH_CREDITS");
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
    state.autumnClientRef = null;
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
    expect((refundCall as any[])[0].featureId).toBe("CREDITS");
    expect((refundCall as any[])[0].overageBehavior).toBe("overflow");
  });

  it("refunds against SEARCH_CREDITS when featureId is provided", async () => {
    const svc = makeService();
    await svc.refundCredits({
      teamId: "team-1",
      value: 1,
      properties: { endpoint: "search" },
      featureId: "SEARCH_CREDITS",
    });

    const refundCall = mockTrack.mock.calls.find(
      (c: any[]) => c[0].value === -1,
    );
    expect(refundCall).toBeDefined();
    expect((refundCall as any[])[0].featureId).toBe("SEARCH_CREDITS");
  });

  it("is a no-op when autumnClient is null", async () => {
    state.autumnClientRef = null;
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
// featureIdForBillingEndpoint
// ---------------------------------------------------------------------------

describe("featureIdForBillingEndpoint", () => {
  it("maps the search endpoint to SEARCH_CREDITS", () => {
    expect(featureIdForBillingEndpoint("search")).toBe("SEARCH_CREDITS");
  });

  it("maps non-search endpoints to CREDITS", () => {
    for (const endpoint of ["scrape", "crawl", "extract", "agent", "map"]) {
      expect(featureIdForBillingEndpoint(endpoint)).toBe("CREDITS");
    }
  });

  it("maps an undefined endpoint to CREDITS", () => {
    expect(featureIdForBillingEndpoint(undefined)).toBe("CREDITS");
  });
});

// ---------------------------------------------------------------------------
// getEntityLimits fallback behavior (concurrency + rate-limit multiplier)
// ---------------------------------------------------------------------------

describe("entity limits fallback", () => {
  it("returns the Autumn values on the happy path", async () => {
    const svc = makeService();
    mockEntityGet.mockResolvedValue({
      balances: {
        CONCURRENCY: { remaining: 7 },
        rate_limits: { granted: 25 },
      },
    });

    expect(await svc.getConcurrencyLimit("team-1", "org-1")).toBe(7);
    expect(await svc.getRateLimitMultiplier("team-1", "org-1")).toBe(25);
  });

  it("falls back LOW (null / multiplier 1) when the entity is missing (404)", async () => {
    const svc = makeService();
    mockEntityGet.mockRejectedValue({ statusCode: 404 });

    expect(await svc.getConcurrencyLimit("team-1", "org-1")).toBeNull();
    expect(await svc.getRateLimitMultiplier("team-1", "org-1")).toBe(1);
  });

  it("falls back LOW when the entity exists but the balances are absent", async () => {
    const svc = makeService();
    mockEntityGet.mockResolvedValue({ balances: {} });

    expect(await svc.getConcurrencyLimit("team-1", "org-1")).toBeNull();
    expect(await svc.getRateLimitMultiplier("team-1", "org-1")).toBe(1);
  });

  it("fails OPEN with high limits when Autumn errors (not a 404)", async () => {
    const svc = makeService();
    mockEntityGet.mockRejectedValue({ statusCode: 500 });

    expect(await svc.getConcurrencyLimit("team-1", "org-1")).toBe(200);
    expect(await svc.getRateLimitMultiplier("team-1", "org-1")).toBe(2500);
  });

  it("fails OPEN when Autumn throws a non-HTTP error", async () => {
    const svc = makeService();
    mockEntityGet.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await svc.getConcurrencyLimit("team-1", "org-1")).toBe(200);
    expect(await svc.getRateLimitMultiplier("team-1", "org-1")).toBe(2500);
  });

  it("does NOT cache the error fail-open value — retries Autumn next call", async () => {
    const svc = makeService();
    mockEntityGet.mockRejectedValueOnce({ statusCode: 500 });
    expect(await svc.getConcurrencyLimit("team-1", "org-1")).toBe(200);

    // Autumn recovers on the next call; the earlier error must not be pinned.
    mockEntityGet.mockResolvedValue({
      balances: { CONCURRENCY: { remaining: 3 }, rate_limits: { granted: 10 } },
    });
    expect(await svc.getConcurrencyLimit("team-1", "org-1")).toBe(3);
    expect(await svc.getRateLimitMultiplier("team-1", "org-1")).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// firebill routing (gradual rollout by org allowlist)
// ---------------------------------------------------------------------------

describe("firebill routing", () => {
  const mockFetch = vi.fn<(url: any, init?: any) => Promise<Response>>();

  const firebillConfig = () => ({
    FIREBILL_URL: "http://firebill.test",
    FIREBILL_SECRET: "fb-secret",
    FIREBILL_ORG_IDS: ["org-1", "org-2"],
  });

  const firebillResponse = (success: boolean) =>
    new Response(JSON.stringify({ success }), { status: 200 });

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(firebillResponse(true));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves a base-path prefix in FIREBILL_URL", async () => {
    state.configRef = {
      ...firebillConfig(),
      FIREBILL_URL: "http://proxy.test/firebill/",
    };

    const svc = makeService();
    await svc.trackCredits({
      teamId: "team-1",
      value: 3,
      properties: { source: "billTeam", endpoint: "scrape" },
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(String(url)).toBe("http://proxy.test/firebill/v1/track");
  });

  it("sends a caller-supplied idempotency key to firebill, and mints one otherwise", async () => {
    state.configRef = firebillConfig();
    const svc = makeService();

    await svc.trackCredits({
      teamId: "team-1",
      value: 5,
      properties: { source: "billScrapeJob", endpoint: "scrape" },
      idempotencyKey: "fc:track:scrape:job-123",
    });
    expect(JSON.parse(mockFetch.mock.calls[0]![1].body).idempotency_key).toBe(
      "fc:track:scrape:job-123",
    );

    await svc.trackCredits({
      teamId: "team-1",
      value: 5,
      properties: { source: "billTeam", endpoint: "search" },
    });
    // A key is always sent, even when the caller has none: firebillTrack retries
    // once, and both attempts have to be the same event or an accepted-but-lost
    // first attempt would be billed twice. firebill would have minted an
    // equivalent UUID itself; minting it here is what makes it stable across
    // the retry.
    const minted = JSON.parse(mockFetch.mock.calls[1]![1].body).idempotency_key;
    expect(minted).toEqual(expect.any(String));
    expect(minted).not.toBe("fc:track:scrape:job-123");
  });

  it("a track/refund pair for one charge carries two distinct keys", async () => {
    state.configRef = firebillConfig();
    const svc = makeService();

    // The convention the billers rely on: same charge identity, different
    // prefix per direction — a shared key would 409 as a duplicate of the
    // track and silently drop the refund.
    await svc.trackCredits({
      teamId: "team-1",
      value: 5,
      properties: { source: "billScrapeJob", endpoint: "scrape" },
      idempotencyKey: "fc:track:scrape:job-123",
    });
    await svc.refundCredits({
      teamId: "team-1",
      value: 5,
      properties: { source: "billScrapeJob", endpoint: "scrape" },
      idempotencyKey: "fc:refund:scrape:job-123",
    });

    const [trackUrl, trackInit] = mockFetch.mock.calls[0]!;
    const [refundUrl, refundInit] = mockFetch.mock.calls[1]!;
    expect(String(trackUrl)).toContain("/v1/track");
    expect(String(refundUrl)).toContain("/v1/refund");
    const trackKey = JSON.parse(trackInit.body).idempotency_key;
    const refundKey = JSON.parse(refundInit.body).idempotency_key;
    expect(trackKey).toBe("fc:track:scrape:job-123");
    expect(refundKey).toBe("fc:refund:scrape:job-123");
    expect(trackKey).not.toBe(refundKey);
  });

  it("routes trackCredits for an allowlisted org to firebill, not Autumn", async () => {
    state.configRef = firebillConfig();
    const svc = makeService();

    const result = await svc.trackCredits({
      teamId: "team-1",
      value: 42,
      properties: { source: "test", endpoint: "extract" },
    });

    expect(result).toBe(true);
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("http://firebill.test/v1/track");
    expect(init.headers.authorization).toBe("Bearer fb-secret");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      customer_id: "org-1",
      entity_id: "team-1",
      feature_id: "CREDITS",
      value: 42,
      properties: { source: "test", endpoint: "extract" },
      // Minted when the caller has none, so the retry inside firebillTrack is
      // the same event rather than a second charge.
      idempotency_key: expect.any(String),
    });
  });

  it("routes refundCredits to /v1/refund with the POSITIVE value", async () => {
    state.configRef = firebillConfig();
    const svc = makeService();

    await svc.refundCredits({
      teamId: "team-1",
      value: 30,
      properties: { endpoint: "extract" },
    });

    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("http://firebill.test/v1/refund");
    const body = JSON.parse(init.body);
    // firebill negates refunds itself — the value must NOT be pre-negated.
    expect(body.value).toBe(30);
    expect(body.properties.source).toBe("autumn_refund");
    expect(body.properties.endpoint).toBe("extract");
  });

  it("uses the direct Autumn path for orgs NOT on the allowlist", async () => {
    state.configRef = {
      ...firebillConfig(),
      FIREBILL_ORG_IDS: ["some-other-org"],
    };
    const svc = makeService();

    const result = await svc.trackCredits({ teamId: "team-1", value: 42 });

    expect(result).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it("uses the direct Autumn path when FIREBILL_SECRET is missing", async () => {
    state.configRef = { ...firebillConfig(), FIREBILL_SECRET: undefined };
    const svc = makeService();

    await svc.trackCredits({ teamId: "team-1", value: 42 });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it("trims whitespace and ignores empty entries in FIREBILL_ORG_IDS", async () => {
    state.configRef = {
      ...firebillConfig(),
      FIREBILL_ORG_IDS: ["  org-1  ", "", "  "],
    };
    const svc = makeService();

    await svc.trackCredits({ teamId: "team-1", value: 1 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("returns false when firebill responds success:false — no Autumn fallback", async () => {
    state.configRef = firebillConfig();
    mockFetch.mockResolvedValue(firebillResponse(false));
    const svc = makeService();

    const result = await svc.trackCredits({ teamId: "team-1", value: 42 });

    expect(result).toBe(false);
    // CRITICAL: firebill may have durably recorded the event; falling back to
    // Autumn here would double-bill the customer.
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("returns false when firebill errors (timeout / refused) — no Autumn fallback", async () => {
    state.configRef = firebillConfig();
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const svc = makeService();

    const result = await svc.trackCredits({ teamId: "team-1", value: 42 });

    expect(result).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("returns false on a non-200 firebill response — no Autumn fallback", async () => {
    state.configRef = firebillConfig();
    mockFetch.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const svc = makeService();

    const result = await svc.trackCredits({ teamId: "team-1", value: 42 });

    expect(result).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // lockCredits / finalizeCreditsLock (the monitor check flow)
  // -------------------------------------------------------------------------

  const lockResponse = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status: 200 });

  it("routes lockCredits for an allowlisted org to /v1/lock, not Autumn", async () => {
    state.configRef = firebillConfig();
    mockFetch.mockResolvedValue(
      lockResponse({
        success: true,
        allowed: true,
        lock_id: "monitor_check-1",
      }),
    );
    const svc = makeService();

    const expiresAt = Date.now() + 60 * 60 * 1000;
    const result = await svc.lockCredits({
      teamId: "team-1",
      value: 10,
      lockId: "monitor_check-1",
      expiresAt,
      properties: { source: "monitorCheck", endpoint: "monitor" },
    });

    expect(result).toEqual({ status: "locked", lockId: "monitor_check-1" });
    expect(mockCheck).not.toHaveBeenCalled();

    const lockCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/v1/lock"),
    );
    expect(lockCall).toBeDefined();
    expect(lockCall![1].headers.authorization).toBe("Bearer fb-secret");
    expect(JSON.parse(lockCall![1].body)).toEqual({
      customer_id: "org-1",
      entity_id: "team-1",
      feature_id: "CREDITS",
      value: 10,
      lock_id: "monitor_check-1",
      expires_at: expiresAt,
      properties: { source: "monitorCheck", endpoint: "monitor" },
    });
  });

  it("defaults the lock expiry when the caller sets none — firebill requires one", async () => {
    state.configRef = firebillConfig();
    mockFetch.mockResolvedValue(
      lockResponse({ success: true, allowed: true, lock_id: "lock-1" }),
    );
    const svc = makeService();

    const before = Date.now();
    await svc.lockCredits({ teamId: "team-1", value: 1, lockId: "lock-1" });

    const lockCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/v1/lock"),
    );
    const body = JSON.parse(lockCall![1].body);
    expect(body.expires_at).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
  });

  it("maps a firebill lock denial to denied", async () => {
    state.configRef = firebillConfig();
    mockFetch.mockResolvedValue(
      lockResponse({ success: true, allowed: false }),
    );
    const svc = makeService();

    const result = await svc.lockCredits({
      teamId: "team-1",
      value: 10,
      lockId: "lock-1",
    });

    expect(result).toEqual({ status: "denied" });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("maps success without a usable allowed to skipped, not denied", async () => {
    state.configRef = firebillConfig();
    // Not a shape firebill sends today; a denial here would hard-stop the
    // monitor check (skipped_no_credits) on what is really a non-answer.
    mockFetch.mockResolvedValue(lockResponse({ success: true }));
    const svc = makeService();

    const result = await svc.lockCredits({
      teamId: "team-1",
      value: 10,
      lockId: "lock-1",
    });

    expect(result).toEqual({ status: "skipped" });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("maps firebill lock unavailability to skipped — proceed unlocked, no Autumn fallback", async () => {
    state.configRef = firebillConfig();
    const svc = makeService();

    mockFetch.mockResolvedValueOnce(lockResponse({ success: false }));
    expect(
      await svc.lockCredits({ teamId: "team-1", value: 10, lockId: "lock-1" }),
    ).toEqual({ status: "skipped" });

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(
      await svc.lockCredits({ teamId: "team-1", value: 10, lockId: "lock-1" }),
    ).toEqual({ status: "skipped" });

    // A firebill-side hold may exist under this lock id; a direct-Autumn
    // retry of the same lock must never be attempted.
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("uses the direct Autumn lock path for orgs NOT on the allowlist", async () => {
    state.configRef = {
      ...firebillConfig(),
      FIREBILL_ORG_IDS: ["some-other-org"],
    };
    const svc = makeService();

    const result = await svc.lockCredits({
      teamId: "team-1",
      value: 10,
      lockId: "lock-1",
    });

    expect(result).toEqual({ status: "locked", lockId: "lock-1" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("routes finalizeCreditsLock through /v1/finalize when teamId is on the rollout", async () => {
    state.configRef = firebillConfig();
    const svc = makeService();

    await svc.finalizeCreditsLock({
      lockId: "monitor_check-1",
      action: "confirm",
      overrideValue: 7,
      properties: { source: "monitorCheck", endpoint: "monitor" },
      teamId: "team-1",
    });

    expect(mockFinalize).not.toHaveBeenCalled();
    const finalizeCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/v1/finalize"),
    );
    expect(finalizeCall).toBeDefined();
    expect(JSON.parse(finalizeCall![1].body)).toEqual({
      lock_id: "monitor_check-1",
      action: "confirm",
      override_value: 7,
      properties: { source: "monitorCheck", endpoint: "monitor" },
      // Deterministic per (lock, action) so a reconciler re-finalize dedupes.
      idempotency_key: "fc:finalize:confirm:monitor_check-1",
    });
  });

  it("omits override_value on a release and keys it separately from a confirm", async () => {
    state.configRef = firebillConfig();
    const svc = makeService();

    await svc.finalizeCreditsLock({
      lockId: "monitor_check-1",
      action: "release",
      teamId: "team-1",
    });

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect("override_value" in body).toBe(false);
    expect(body.idempotency_key).toBe("fc:finalize:release:monitor_check-1");
  });

  it("finalizes directly in Autumn when no teamId is supplied", async () => {
    state.configRef = firebillConfig();
    const svc = makeService();

    await svc.finalizeCreditsLock({ lockId: "lock-1", action: "release" });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockFinalize).toHaveBeenCalledTimes(1);
  });

  it("finalizes directly in Autumn when the team's org is NOT on the allowlist", async () => {
    state.configRef = {
      ...firebillConfig(),
      FIREBILL_ORG_IDS: ["some-other-org"],
    };
    const svc = makeService();

    await svc.finalizeCreditsLock({
      lockId: "lock-1",
      action: "confirm",
      teamId: "team-1",
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockFinalize).toHaveBeenCalledTimes(1);
  });
});
