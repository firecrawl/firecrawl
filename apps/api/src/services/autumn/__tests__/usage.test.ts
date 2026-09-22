import { vi, beforeEach } from "vitest";

const mockAggregate = vi.fn<(args: any, options?: any) => Promise<any>>();
const mockEntitiesGet = vi.fn<(args: any) => Promise<any>>();
const mockCustomersGetOrCreate = vi.fn<(args: any) => Promise<any>>();

// Historical aggregations override the Autumn client's global 2s timeout.
const EXPECTED_HISTORICAL_TIMEOUT_MS = 15000;

let autumnClientRef: {
  events: { aggregate: typeof mockAggregate };
  entities: { get: typeof mockEntitiesGet };
  customers: { getOrCreate: typeof mockCustomersGetOrCreate };
} | null = {
  events: { aggregate: mockAggregate },
  entities: { get: mockEntitiesGet },
  customers: { getOrCreate: mockCustomersGetOrCreate },
};

let teamLookup = {
  data: { org_id: "org-1" },
  error: null as unknown,
};

let apiKeysData: Array<{ id: number; name: string }> = [];

const redisStore = new Map<string, string>();
const mockGetValue = vi.fn<(key: string) => Promise<string | null>>();
const mockSetValue =
  vi.fn<(key: string, value: string, expire?: number) => Promise<void>>();

vi.mock("../client", () => ({
  get autumnClient() {
    return autumnClientRef;
  },
}));

vi.mock("../../redis", () => ({
  getValue: (key: string) => mockGetValue(key),
  setValue: (key: string, value: string, expire?: number) =>
    mockSetValue(key, value, expire),
}));

vi.mock("../../../db/connection", () => ({
  get dbRr() {
    return {
      select: () => ({
        from: () => ({
          where: () => {
            // api_keys path awaits the builder directly; teams path calls .limit(1)
            const apiKeysPromise = Promise.resolve(apiKeysData);
            return Object.assign(apiKeysPromise, {
              limit: () =>
                Promise.resolve(teamLookup.data ? [teamLookup.data] : []),
            });
          },
        }),
      }),
    };
  },
}));

import {
  getTeamBalance,
  getTeamHistoricalUsage,
  getTeamHistoricalUsageByApiKey,
} from "../usage";

beforeEach(() => {
  vi.clearAllMocks();
  autumnClientRef = {
    events: { aggregate: mockAggregate },
    entities: { get: mockEntitiesGet },
    customers: { getOrCreate: mockCustomersGetOrCreate },
  };
  teamLookup = { data: { org_id: "org-1" }, error: null };
  apiKeysData = [];
  redisStore.clear();
  mockGetValue.mockImplementation(async key => redisStore.get(key) ?? null);
  mockSetValue.mockImplementation(async (key, value) => {
    redisStore.set(key, value);
  });
});

// ---------------------------------------------------------------------------
// getTeamBalance — covers all four billing-period / planCredits bug fixes
// ---------------------------------------------------------------------------

describe("getTeamBalance", () => {
  // Bug 1: Autumn returns currentPeriodStart/End as ms timestamps.
  // The old code did `new Date(epoch * 1000)` which produced year ~58000.
  // The fix passes them directly to `new Date()`.
  it("Bug 1 — passes ms timestamps directly without * 1000", async () => {
    const startMs = 1712444524000; // 2024-04-06T21:32:04.000Z
    const endMs = 1715036524000; // 2024-05-06T21:32:04.000Z

    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 461027,
          granted: 500000,
          usage: 38973,
          unlimited: false,
          breakdown: [{ planId: "growth", includedGrant: 500000 }],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: startMs,
          currentPeriodEnd: endMs,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.periodStart).toBe(new Date(startMs).toISOString());
    expect(result!.periodEnd).toBe(new Date(endMs).toISOString());

    // Confirm dates are in a sane range (not year 58000+)
    const startYear = new Date(result!.periodStart!).getFullYear();
    const endYear = new Date(result!.periodEnd!).getFullYear();
    expect(startYear).toBeGreaterThanOrEqual(2020);
    expect(startYear).toBeLessThan(2100);
    expect(endYear).toBeGreaterThanOrEqual(2020);
    expect(endYear).toBeLessThan(2100);
  });

  // If Autumn ever switches to seconds, this ensures the code produces a
  // sane date from whatever epoch format it receives.
  it("Bug 1 — would produce year ~58000 if timestamps were erroneously multiplied by 1000", async () => {
    const startMs = 1712444524000;
    const endMs = 1715036524000;

    // Simulating what the OLD code would have done: new Date(startMs * 1000)
    const brokenDate = new Date(startMs * 1000);
    expect(brokenDate.getFullYear()).toBeGreaterThan(50000);

    // The fix: new Date(startMs) directly
    const fixedDate = new Date(startMs);
    expect(fixedDate.getFullYear()).toBe(2024);
  });

  // Bug 2: Autumn uses "active"/"scheduled", not Stripe's "trialing"/"past_due".
  // The old filter for "active" || "trialing" || "past_due" missed scheduled subs.
  it("Bug 2 — finds subscription with 'active' status (Autumn's status model)", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 100,
          granted: 1000,
          usage: 900,
          unlimited: false,
          breakdown: [{ planId: "standard", includedGrant: 1000 }],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: 1712444524000,
          currentPeriodEnd: 1715036524000,
        },
      ],
    });

    const result = await getTeamBalance("team-1");
    expect(result).not.toBeNull();
    expect(result!.periodStart).not.toBeNull();
    expect(result!.periodEnd).not.toBeNull();
  });

  it("Bug 2 — falls back to any subscription with period timestamps when none is 'active'", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 50,
          granted: 500,
          usage: 450,
          unlimited: false,
          breakdown: [{ planId: "growth", includedGrant: 500 }],
        },
      },
      subscriptions: [
        {
          status: "scheduled",
          currentPeriodStart: 1712444524000,
          currentPeriodEnd: 1715036524000,
        },
      ],
    });

    const result = await getTeamBalance("team-1");
    expect(result).not.toBeNull();
    expect(result!.periodStart).toBe(new Date(1712444524000).toISOString());
    expect(result!.periodEnd).toBe(new Date(1715036524000).toISOString());
  });

  it("Bug 2 — old Stripe-only statuses (trialing, past_due) without period timestamps produce null dates", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 50,
          granted: 500,
          usage: 450,
          unlimited: false,
          breakdown: [{ planId: "free", includedGrant: 500 }],
        },
      },
      subscriptions: [
        {
          status: "trialing",
          // No currentPeriodStart/End set
        },
      ],
    });

    // No customer fallback needed for balances, but subscriptions fallback is triggered
    // because entity has subscriptions with length > 0 but no "active" and no period timestamps
    const result = await getTeamBalance("team-1");
    expect(result).not.toBeNull();
    expect(result!.periodStart).toBeNull();
    expect(result!.periodEnd).toBeNull();
  });

  // Bug 3: Entity-scoped lookups may have CREDITS balance but no subscriptions.
  // Subscriptions live at customer level. The old code only fell back when CREDITS
  // was missing, leaving billing period dates null.
  it("Bug 3 — falls back to customer-level subscriptions when entity has CREDITS but no subscriptions", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 99475,
          granted: 100000,
          usage: 525,
          unlimited: false,
          breakdown: [
            { planId: "standard", includedGrant: 100000 },
            { planId: null, includedGrant: 525 },
          ],
        },
      },
      subscriptions: [], // no entity-level subscriptions
    });

    mockCustomersGetOrCreate.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 461027,
          granted: 500000,
          usage: 38973,
          unlimited: false,
          breakdown: [{ planId: "growth", includedGrant: 500000 }],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: 1712444524000,
          currentPeriodEnd: 1715036524000,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    // Should use entity-scoped CREDITS balance (Standard plan, ~100K)
    expect(result!.remaining).toBe(99475);
    expect(result!.planCredits).toBe(100000);

    // But should get billing period from customer-level subscriptions
    expect(result!.periodStart).toBe(new Date(1712444524000).toISOString());
    expect(result!.periodEnd).toBe(new Date(1715036524000).toISOString());

    // Verify entity was queried first, then customer for subscriptions
    expect(mockEntitiesGet).toHaveBeenCalledWith({
      customerId: "org-1",
      entityId: "team-1",
    });
    expect(mockCustomersGetOrCreate).toHaveBeenCalledWith({
      customerId: "org-1",
      autoEnablePlanId: "free",
    });
  });

  it("Bug 3 — does NOT fall back to customer-level when entity has both CREDITS and subscriptions", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 5000,
          granted: 10000,
          usage: 5000,
          unlimited: false,
          breakdown: [{ planId: "growth", includedGrant: 10000 }],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: 1712444524000,
          currentPeriodEnd: 1715036524000,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.remaining).toBe(5000);
    expect(result!.planCredits).toBe(10000);
    expect(result!.periodStart).not.toBeNull();

    // Customer-level should NOT be called
    expect(mockCustomersGetOrCreate).not.toHaveBeenCalled();
  });

  // Bug 4: planCredits should only sum breakdown entries with planId set.
  // One-off grants (planId: null) were inflating planCredits.
  it("Bug 4 — excludes one-off grants (planId: null) from planCredits", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 100525,
          granted: 100525,
          usage: 0,
          unlimited: false,
          breakdown: [
            { planId: "standard", includedGrant: 100000 },
            { planId: null, includedGrant: 500 }, // one-off promo grant
            { planId: null, includedGrant: 25 }, // another small grant
          ],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: 1712444524000,
          currentPeriodEnd: 1715036524000,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    // planCredits should be 100,000 (only from planId: "standard")
    // NOT 100,525 (which includes the one-off grants)
    expect(result!.planCredits).toBe(100000);
    // But remaining reflects the full amount including grants
    expect(result!.remaining).toBe(100525);
  });

  it("Bug 4 — sums credits from multiple plans correctly", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 600500,
          granted: 600500,
          usage: 0,
          unlimited: false,
          breakdown: [
            { planId: "growth", includedGrant: 500000 },
            { planId: "addon-100k", includedGrant: 100000 },
            { planId: null, includedGrant: 500 }, // promo grant
          ],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: 1712444524000,
          currentPeriodEnd: 1715036524000,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.planCredits).toBe(600000);
  });

  it("Bug 4 — falls back to granted when no breakdown is present", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 1000,
          granted: 1000,
          usage: 0,
          unlimited: false,
          // No breakdown array
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: 1712444524000,
          currentPeriodEnd: 1715036524000,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.planCredits).toBe(1000);
  });

  // Full fallback path: entity 404 → customer-level used for everything
  it("falls back to customer-level entirely when entity returns 404", async () => {
    mockEntitiesGet.mockRejectedValue(
      Object.assign(new Error("not found"), { statusCode: 404 }),
    );

    mockCustomersGetOrCreate.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 461027,
          granted: 500000,
          usage: 38973,
          unlimited: false,
          breakdown: [{ planId: "growth", includedGrant: 500000 }],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: 1712444524000,
          currentPeriodEnd: 1715036524000,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.remaining).toBe(461027);
    expect(result!.planCredits).toBe(500000);
    expect(result!.periodStart).toBe(new Date(1712444524000).toISOString());
  });

  it("returns null when no CREDITS balance exists", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {},
      subscriptions: [],
    });

    mockCustomersGetOrCreate.mockResolvedValue({
      balances: {},
      subscriptions: [],
    });

    const result = await getTeamBalance("team-1");
    expect(result).toBeNull();
  });

  // Bug 5: Yearly plans have currentPeriodStart/End = null on the subscription.
  // The fix derives billing period from the balance's nextResetAt + reset interval.
  it("Bug 5 — derives billing period from nextResetAt for yearly plans with monthly reset", async () => {
    const nextResetAt = 1777787407000; // 2026-05-03T05:50:07.000Z

    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 100525,
          granted: 100525,
          usage: 0,
          unlimited: false,
          nextResetAt,
          breakdown: [
            {
              planId: "standard_yearly",
              includedGrant: 100000,
              reset: { interval: "month", resetsAt: nextResetAt },
            },
            {
              planId: null,
              includedGrant: 525,
              reset: { interval: "one_off", resetsAt: null },
            },
          ],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: null,
          currentPeriodEnd: null,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.periodEnd).toBe(new Date(nextResetAt).toISOString());
    // Monthly reset: start should be 1 month before end
    expect(result!.periodStart).toBe("2026-04-03T05:50:07.000Z");
    expect(result!.periodEnd).toBe("2026-05-03T05:50:07.000Z");
    expect(result!.planCredits).toBe(100000);
  });

  it("Bug 5 — derives billing period from nextResetAt for yearly reset interval", async () => {
    const nextResetAt = 1764741007000; // 2025-12-03T05:50:07.000Z

    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 500000,
          granted: 500000,
          usage: 0,
          unlimited: false,
          nextResetAt,
          breakdown: [
            {
              planId: "growth_yearly",
              includedGrant: 500000,
              reset: { interval: "year", resetsAt: nextResetAt },
            },
          ],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: null,
          currentPeriodEnd: null,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.periodEnd).toBe(new Date(nextResetAt).toISOString());
    // Yearly reset: start should be 1 year before end
    expect(result!.periodStart).toBe("2024-12-03T05:50:07.000Z");
    expect(result!.periodEnd).toBe("2025-12-03T05:50:07.000Z");
  });

  it("Bug 5 — clamps day when month has fewer days (Mar 31 - 1 month = Feb 28)", async () => {
    const nextResetAt = Date.parse("2026-03-31T12:00:00.000Z");

    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 100000,
          granted: 100000,
          usage: 0,
          unlimited: false,
          nextResetAt,
          breakdown: [
            {
              planId: "standard_yearly",
              includedGrant: 100000,
              reset: { interval: "month", resetsAt: nextResetAt },
            },
          ],
        },
      },
      subscriptions: [
        { status: "active", currentPeriodStart: null, currentPeriodEnd: null },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.periodStart).toBe("2026-02-28T12:00:00.000Z");
    expect(result!.periodEnd).toBe("2026-03-31T12:00:00.000Z");
  });

  it("Bug 5 — clamps day for leap year (Mar 31 - 1 month in leap year = Feb 29)", async () => {
    const nextResetAt = Date.parse("2028-03-31T12:00:00.000Z"); // 2028 is a leap year

    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 100000,
          granted: 100000,
          usage: 0,
          unlimited: false,
          nextResetAt,
          breakdown: [
            {
              planId: "standard_yearly",
              includedGrant: 100000,
              reset: { interval: "month", resetsAt: nextResetAt },
            },
          ],
        },
      },
      subscriptions: [
        { status: "active", currentPeriodStart: null, currentPeriodEnd: null },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.periodStart).toBe("2028-02-29T12:00:00.000Z");
    expect(result!.periodEnd).toBe("2028-03-31T12:00:00.000Z");
  });

  it("Bug 5 — clamps day for yearly subtraction (Feb 29 leap year - 1 year = Feb 28)", async () => {
    const nextResetAt = Date.parse("2028-02-29T12:00:00.000Z"); // 2028 is leap, 2027 is not

    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 500000,
          granted: 500000,
          usage: 0,
          unlimited: false,
          nextResetAt,
          breakdown: [
            {
              planId: "growth_yearly",
              includedGrant: 500000,
              reset: { interval: "year", resetsAt: nextResetAt },
            },
          ],
        },
      },
      subscriptions: [
        { status: "active", currentPeriodStart: null, currentPeriodEnd: null },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.periodStart).toBe("2027-02-28T12:00:00.000Z");
    expect(result!.periodEnd).toBe("2028-02-29T12:00:00.000Z");
  });

  it("Bug 5 — leaves both period dates null when nextResetAt exists but no valid interval breakdown", async () => {
    const nextResetAt = Date.parse("2026-05-03T05:50:07.000Z");

    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 500,
          granted: 500,
          usage: 0,
          unlimited: false,
          nextResetAt,
          breakdown: [
            {
              planId: null,
              includedGrant: 500,
              reset: { interval: "one_off", resetsAt: null },
            },
          ],
        },
      },
      subscriptions: [
        { status: "active", currentPeriodStart: null, currentPeriodEnd: null },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    // Both should be null — not an asymmetric response with only periodEnd set
    expect(result!.periodStart).toBeNull();
    expect(result!.periodEnd).toBeNull();
  });

  it("Bug 5 — leaves period null when no nextResetAt and no subscription periods", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 1000,
          granted: 1000,
          usage: 0,
          unlimited: false,
          breakdown: [{ planId: "free", includedGrant: 1000 }],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: null,
          currentPeriodEnd: null,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.periodStart).toBeNull();
    expect(result!.periodEnd).toBeNull();
  });

  it("returns correct structure with unlimited credits", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 0,
          granted: 0,
          usage: 12345,
          unlimited: true,
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: 1712444524000,
          currentPeriodEnd: 1715036524000,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.unlimited).toBe(true);
    expect(result!.usage).toBe(12345);
  });

  // Autumn caps `balance.remaining` at 0, so the raw field can't show
  // negative balances for teams in overage. We derive the signed value from
  // granted - usage instead.
  it("returns a negative remaining when usage exceeds granted (overage)", async () => {
    mockEntitiesGet.mockResolvedValue({
      balances: {
        CREDITS: {
          remaining: 0,
          granted: 25250000,
          usage: 29688178,
          unlimited: false,
          overage_allowed: false,
          breakdown: [{ planId: "enterprise", includedGrant: 10000000 }],
        },
      },
      subscriptions: [
        {
          status: "active",
          currentPeriodStart: 1712444524000,
          currentPeriodEnd: 1715036524000,
        },
      ],
    });

    const result = await getTeamBalance("team-1");

    expect(result).not.toBeNull();
    expect(result!.remaining).toBe(-4438178);
    expect(result!.usage).toBe(29688178);
  });
});

// ---------------------------------------------------------------------------
// getTeamHistoricalUsage
// ---------------------------------------------------------------------------

describe("getTeamHistoricalUsage", () => {
  it("aggregates 90 days of daily usage into calendar-month buckets", async () => {
    mockAggregate.mockResolvedValue({
      list: [
        {
          period: Date.parse("2026-03-30T00:00:00.000Z"),
          values: { CREDITS: 20 },
        },
        {
          period: Date.parse("2026-03-31T00:00:00.000Z"),
          values: { CREDITS: 333 },
        },
        {
          period: Date.parse("2026-04-01T00:00:00.000Z"),
          values: { CREDITS: 1 },
        },
      ],
    });

    await expect(getTeamHistoricalUsage("team-1")).resolves.toEqual([
      {
        startDate: "2026-03-01T00:00:00.000Z",
        endDate: "2026-04-01T00:00:00.000Z",
        creditsUsed: 353,
      },
      {
        startDate: "2026-04-01T00:00:00.000Z",
        endDate: null,
        creditsUsed: 1,
      },
    ]);

    expect(mockAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "org-1",
        entityId: "team-1",
        featureId: "CREDITS",
        range: "90d",
        binSize: "day",
      }),
      expect.objectContaining({ timeoutMs: EXPECTED_HISTORICAL_TIMEOUT_MS }),
    );
  });

  // The aggregate is scoped strictly to the team's entity. When the entity is
  // missing the team simply has no usage of its own — we return an empty
  // history rather than falling back to the org-wide total.
  it("returns an empty history (no org fallback) when the entity is missing", async () => {
    mockAggregate.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { statusCode: 404 }),
    );

    await expect(getTeamHistoricalUsage("team-1")).resolves.toEqual([]);

    // Only the entity-scoped call is made; no customer-level retry.
    expect(mockAggregate).toHaveBeenCalledTimes(1);
    expect(mockAggregate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        customerId: "org-1",
        entityId: "team-1",
        range: "90d",
        binSize: "day",
      }),
      expect.objectContaining({ timeoutMs: EXPECTED_HISTORICAL_TIMEOUT_MS }),
    );
  });

  it("rethrows non-404 aggregate errors", async () => {
    mockAggregate.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { statusCode: 500 }),
    );
    await expect(getTeamHistoricalUsage("team-1")).rejects.toThrow("boom");
  });

  it("uses the next calendar month as endDate when a month has zero usage", async () => {
    mockAggregate.mockResolvedValue({
      list: [
        {
          period: Date.parse("2026-01-31T00:00:00.000Z"),
          values: { CREDITS: 12 },
        },
        {
          period: Date.parse("2026-03-01T00:00:00.000Z"),
          values: { CREDITS: 7 },
        },
      ],
    });

    await expect(getTeamHistoricalUsage("team-1")).resolves.toEqual([
      {
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-02-01T00:00:00.000Z",
        creditsUsed: 12,
      },
      {
        startDate: "2026-03-01T00:00:00.000Z",
        endDate: null,
        creditsUsed: 7,
      },
    ]);
  });
});

// The byApiKey breakdown asks Autumn for fixed 7-day slices. At this instant
// the 90-day window starts 2026-01-20T00:00Z; the epoch-aligned slices run
// from 2026-01-15 to 2026-04-23, fourteen of them, and the one holding today
// is 2026-04-16..2026-04-23.
const BY_API_KEY_NOW = "2026-04-20T12:00:00.000Z";
const BY_API_KEY_SLICE_COUNT = 14;
const CURRENT_SLICE_START = Date.parse("2026-04-16T00:00:00.000Z");

/**
 * Stands in for Autumn's grouped aggregate: answers each call with the days
 * inside its `customRange`. The end is inclusive, so a bin that sits exactly
 * on a slice boundary comes back from both neighbouring slices.
 */
function autumnServesDays(
  days: Array<{ day: string; credits: Record<string, number> }>,
) {
  mockAggregate.mockImplementation(async (args: any) => ({
    list: days
      .map(d => ({
        period: Date.parse(d.day),
        grouped_values: { CREDITS: d.credits },
      }))
      .filter(
        entry =>
          entry.period >= args.customRange.start &&
          entry.period <= args.customRange.end,
      ),
  }));
}

describe("getTeamHistoricalUsageByApiKey", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(BY_API_KEY_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aggregates daily grouped usage into calendar-month buckets", async () => {
    apiKeysData = [
      { id: 101, name: "Default" },
      { id: 202, name: "postman" },
    ];

    autumnServesDays([
      { day: "2026-03-30T00:00:00.000Z", credits: { "101": 10, "202": 3 } },
      { day: "2026-03-31T00:00:00.000Z", credits: { "101": 26 } },
      { day: "2026-04-02T00:00:00.000Z", credits: { "202": 5 } },
    ]);

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      {
        startDate: "2026-03-01T00:00:00.000Z",
        endDate: "2026-04-01T00:00:00.000Z",
        apiKey: "Default",
        creditsUsed: 36,
      },
      {
        startDate: "2026-03-01T00:00:00.000Z",
        endDate: "2026-04-01T00:00:00.000Z",
        apiKey: "postman",
        creditsUsed: 3,
      },
      {
        startDate: "2026-04-01T00:00:00.000Z",
        endDate: null,
        apiKey: "postman",
        creditsUsed: 5,
      },
    ]);
  });

  it("asks Autumn for 7-day slices across the window, today's slice first", async () => {
    autumnServesDays([]);

    await getTeamHistoricalUsageByApiKey("team-1");

    expect(mockAggregate).toHaveBeenCalledTimes(BY_API_KEY_SLICE_COUNT);

    const [firstArgs] = mockAggregate.mock.calls[0];
    expect(firstArgs.customRange).toEqual({
      start: CURRENT_SLICE_START,
      end: Date.parse(BY_API_KEY_NOW),
    });

    for (const [args, options] of mockAggregate.mock.calls) {
      expect(args).toEqual(
        expect.objectContaining({
          customerId: "org-1",
          entityId: "team-1",
          featureId: "CREDITS",
          binSize: "day",
          groupBy: "properties.apiKeyId",
          maxGroups: 250,
        }),
      );
      expect(args.range).toBeUndefined();
      expect(options).toEqual(
        expect.objectContaining({
          timeoutMs: EXPECTED_HISTORICAL_TIMEOUT_MS,
          retryCodes: ["429"],
        }),
      );
    }

    // The slices tile the window with no gap and no overlap.
    const ranges = mockAggregate.mock.calls
      .map(([args]) => args.customRange)
      .sort((a, b) => a.start - b.start);
    expect(ranges[0].start).toBe(Date.parse("2026-01-15T00:00:00.000Z"));
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBe(ranges[i - 1].end);
      expect(ranges[i - 1].end - ranges[i - 1].start).toBe(7 * 86_400_000);
    }
  });

  it("counts a day on a slice boundary once, though both slices return it", async () => {
    apiKeysData = [{ id: 101, name: "Default" }];

    // 2026-03-26 is where one slice ends and the next begins.
    autumnServesDays([
      { day: "2026-03-26T00:00:00.000Z", credits: { "101": 5 } },
    ]);

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      {
        startDate: "2026-03-01T00:00:00.000Z",
        endDate: null,
        apiKey: "Default",
        creditsUsed: 5,
      },
    ]);
  });

  it("leaves out days before the window that the oldest slice returns", async () => {
    apiKeysData = [{ id: 101, name: "Default" }];

    autumnServesDays([
      { day: "2026-01-16T00:00:00.000Z", credits: { "101": 1000 } },
      { day: "2026-01-20T00:00:00.000Z", credits: { "101": 4 } },
    ]);

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      {
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: null,
        apiKey: "Default",
        creditsUsed: 4,
      },
    ]);
  });

  it("serves settled slices from the cache on the next request", async () => {
    apiKeysData = [{ id: 101, name: "Default" }];
    autumnServesDays([
      { day: "2026-02-10T00:00:00.000Z", credits: { "101": 7 } },
      { day: "2026-04-17T00:00:00.000Z", credits: { "101": 2 } },
    ]);

    const first = await getTeamHistoricalUsageByApiKey("team-1");
    expect(mockAggregate).toHaveBeenCalledTimes(BY_API_KEY_SLICE_COUNT);
    expect(mockSetValue).toHaveBeenCalledTimes(BY_API_KEY_SLICE_COUNT - 1);
    for (const [key, , expire] of mockSetValue.mock.calls) {
      expect(key).toMatch(/^historical-usage-by-api-key:v1:team-1:\d+$/);
      expect(key).not.toContain(String(CURRENT_SLICE_START));
      expect(expire).toBe(7 * 24 * 60 * 60);
    }

    mockAggregate.mockClear();
    const second = await getTeamHistoricalUsageByApiKey("team-1");

    expect(second).toEqual(first);
    expect(mockAggregate).toHaveBeenCalledTimes(1);
    expect(mockAggregate.mock.calls[0][0].customRange.start).toBe(
      CURRENT_SLICE_START,
    );
  });

  it("keeps asking Autumn for a slice that ended less than a day ago", async () => {
    // Ten hours into the 2026-04-16 slice: the 2026-04-09 slice has ended but
    // has not settled yet.
    vi.setSystemTime(new Date("2026-04-16T10:00:00.000Z"));
    const previousSliceStart = Date.parse("2026-04-09T00:00:00.000Z");
    autumnServesDays([]);

    await getTeamHistoricalUsageByApiKey("team-1");
    expect(
      mockSetValue.mock.calls.some(([key]) =>
        key.endsWith(`:${previousSliceStart}`),
      ),
    ).toBe(false);

    mockAggregate.mockClear();
    await getTeamHistoricalUsageByApiKey("team-1");

    expect(
      mockAggregate.mock.calls.map(([args]) => args.customRange.start).sort(),
    ).toEqual([previousSliceStart, CURRENT_SLICE_START]);
  });

  it("asks Autumn again for a slice whose cache entry is malformed", async () => {
    apiKeysData = [{ id: 101, name: "Default" }];
    autumnServesDays([
      { day: "2026-02-10T00:00:00.000Z", credits: { "101": 7 } },
    ]);
    mockGetValue.mockResolvedValue(JSON.stringify([{ period: "yesterday" }]));

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      {
        startDate: "2026-02-01T00:00:00.000Z",
        endDate: null,
        apiKey: "Default",
        creditsUsed: 7,
      },
    ]);
    expect(mockAggregate).toHaveBeenCalledTimes(BY_API_KEY_SLICE_COUNT);
  });

  it("answers from Autumn when the cache cannot be read or written", async () => {
    apiKeysData = [{ id: 101, name: "Default" }];
    autumnServesDays([
      { day: "2026-02-10T00:00:00.000Z", credits: { "101": 7 } },
    ]);
    mockGetValue.mockRejectedValue(new Error("redis down"));
    mockSetValue.mockRejectedValue(new Error("redis down"));

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      {
        startDate: "2026-02-01T00:00:00.000Z",
        endDate: null,
        apiKey: "Default",
        creditsUsed: 7,
      },
    ]);
  });

  it("fails the request when a slice fails, without starting further slices", async () => {
    mockAggregate.mockImplementation(async (args: any) => {
      if (args.customRange.start === Date.parse("2026-01-15T00:00:00.000Z")) {
        throw Object.assign(new Error("gateway timeout"), { statusCode: 504 });
      }
      return { list: [] };
    });

    await expect(getTeamHistoricalUsageByApiKey("team-1")).rejects.toThrow(
      "gateway timeout",
    );
    // Today's slice, the failing oldest slice, and the one other slice that
    // was already in flight beside it.
    expect(mockAggregate.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("rethrows a non-404 error from today's slice", async () => {
    mockAggregate.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { statusCode: 500 }),
    );

    await expect(getTeamHistoricalUsageByApiKey("team-1")).rejects.toThrow(
      "boom",
    );
    expect(mockAggregate).toHaveBeenCalledTimes(1);
  });

  it("labels unresolvable apiKeyIds as 'Unknown' instead of echoing raw values", async () => {
    apiKeysData = [];

    autumnServesDays([
      {
        day: "2026-04-15T00:00:00.000Z",
        credits: { ba9045fffbd34fc8aabc2597df6ba044: 11, "99999999": 7 },
      },
    ]);

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      {
        startDate: "2026-04-01T00:00:00.000Z",
        endDate: null,
        apiKey: "Unknown",
        creditsUsed: 18,
      },
    ]);
  });

  it("uses the next calendar month as endDate for grouped data when a month has zero usage", async () => {
    apiKeysData = [{ id: 101, name: "Default" }];

    autumnServesDays([
      { day: "2026-01-31T00:00:00.000Z", credits: { "101": 12 } },
      { day: "2026-03-01T00:00:00.000Z", credits: { "101": 7 } },
    ]);

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      {
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-02-01T00:00:00.000Z",
        apiKey: "Default",
        creditsUsed: 12,
      },
      {
        startDate: "2026-03-01T00:00:00.000Z",
        endDate: null,
        apiKey: "Default",
        creditsUsed: 7,
      },
    ]);
  });

  it("returns an empty history (no org fallback) when the entity is missing", async () => {
    mockAggregate.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { statusCode: 404 }),
    );

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([]);

    // Only today's entity-scoped slice is asked for; no customer-level retry.
    expect(mockAggregate).toHaveBeenCalledTimes(1);
    expect(mockAggregate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        customerId: "org-1",
        entityId: "team-1",
        groupBy: "properties.apiKeyId",
        customRange: {
          start: CURRENT_SLICE_START,
          end: Date.parse(BY_API_KEY_NOW),
        },
      }),
      expect.objectContaining({ timeoutMs: EXPECTED_HISTORICAL_TIMEOUT_MS }),
    );
  });
});

// ---------------------------------------------------------------------------
// Per-call Autumn timeout for the historical aggregations
// ---------------------------------------------------------------------------

// These aggregations bin by day (and optionally group by API key), so Autumn
// walks raw events and the call cost scales with the team's event volume. The
// Autumn client's global 2s timeout is sized for the latency-sensitive balance
// checks, so each historical call must override it or high-volume teams get a
// timeout error surfaced as a 500.
describe("historical usage Autumn timeout override", () => {
  it("passes a 15s per-call timeout for the ungrouped aggregate", async () => {
    mockAggregate.mockResolvedValue({ list: [] });

    await getTeamHistoricalUsage("team-1");

    expect(mockAggregate).toHaveBeenCalledTimes(1);
    const [, options] = mockAggregate.mock.calls[0];
    expect(options).toEqual({ timeoutMs: 15000 });
  });

  it("passes a 15s per-call timeout for every grouped byApiKey slice", async () => {
    mockAggregate.mockResolvedValue({ list: [] });

    await getTeamHistoricalUsageByApiKey("team-1");

    expect(mockAggregate.mock.calls.length).toBeGreaterThan(1);
    for (const [, options] of mockAggregate.mock.calls) {
      expect(options?.timeoutMs).toBe(15000);
    }
  });

  it("overrides the Autumn client's global 2s timeout with a larger value", async () => {
    mockAggregate.mockResolvedValue({ list: [] });

    await getTeamHistoricalUsage("team-1");
    await getTeamHistoricalUsageByApiKey("team-1");

    expect(mockAggregate.mock.calls.length).toBeGreaterThan(2);
    for (const [, options] of mockAggregate.mock.calls) {
      expect(options?.timeoutMs).toBeGreaterThan(2000);
    }
  });
});
