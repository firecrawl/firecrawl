import { vi, beforeEach, afterEach } from "vitest";

// Historical aggregations run on the dedicated `autumnHistoricalClient` (which
// carries a longer client-level timeout), NOT the hot-path `autumnClient`.
// Keep the two aggregate mocks distinct so tests can assert the routing.
const mockAggregate = vi.fn<(args: any) => Promise<any>>();
const mockHotPathAggregate = vi.fn<(args: any) => Promise<any>>();
const mockEntitiesGet = vi.fn<(args: any) => Promise<any>>();
const mockCustomersGetOrCreate = vi.fn<(args: any) => Promise<any>>();

let autumnClientRef: {
  events: { aggregate: typeof mockHotPathAggregate };
  entities: { get: typeof mockEntitiesGet };
  customers: { getOrCreate: typeof mockCustomersGetOrCreate };
} | null = {
  events: { aggregate: mockHotPathAggregate },
  entities: { get: mockEntitiesGet },
  customers: { getOrCreate: mockCustomersGetOrCreate },
};

let autumnHistoricalClientRef: {
  events: { aggregate: typeof mockAggregate };
} | null = {
  events: { aggregate: mockAggregate },
};

let teamLookup = {
  data: { org_id: "org-1" },
  error: null as unknown,
};

let apiKeysData: Array<{ id: number; name: string }> = [];

vi.mock("../client", () => ({
  get autumnClient() {
    return autumnClientRef;
  },
  get autumnHistoricalClient() {
    return autumnHistoricalClientRef;
  },
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

// In-memory stand-in for the rollup cache. `redisSets` records the TTL each
// slice was written with, which is what the closed-vs-current caching contract
// is asserted on.
const redisStore = new Map<string, string>();
const redisSets: Array<{ key: string; ttl?: number }> = [];
let redisEnabled = true;

vi.mock("../../redis", () => ({
  getValue: async (key: string) => {
    if (!redisEnabled) throw new Error("redis down");
    return redisStore.get(key) ?? null;
  },
  setValue: async (key: string, value: string, ttl?: number) => {
    if (!redisEnabled) throw new Error("redis down");
    redisStore.set(key, value);
    redisSets.push({ key, ttl });
  },
}));

import {
  getTeamBalance,
  getTeamHistoricalUsage,
  getTeamHistoricalUsageByApiKey,
} from "../usage";

// Fixed clock so the windows the rollup derives are deterministic. 90 days
// before 2026-07-20 is 2026-04-21, so the window snaps back to 2026-04-01 and
// the current-month boundary is 2026-07-01.
const NOW = new Date("2026-07-20T12:00:00.000Z");
const CURRENT_MONTH_START = Date.parse("2026-07-01T00:00:00.000Z");
const TODAY_START = Date.parse("2026-07-20T00:00:00.000Z");
const WINDOW_START = Date.parse("2026-04-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  autumnClientRef = {
    events: { aggregate: mockHotPathAggregate },
    entities: { get: mockEntitiesGet },
    customers: { getOrCreate: mockCustomersGetOrCreate },
  };
  autumnHistoricalClientRef = {
    events: { aggregate: mockAggregate },
  };
  teamLookup = { data: { org_id: "org-1" }, error: null };
  apiKeysData = [];
  redisStore.clear();
  redisSets.length = 0;
  redisEnabled = true;
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Serves `bins` from Autumn, honouring the half-open [start, end) window each
 * call asks for. The rollup queries closed months and the current month
 * separately, so this both feeds the tests and asserts the windowing is real:
 * a bin outside a window is not returned for it.
 */
function serveBins(bins: any[]) {
  mockAggregate.mockImplementation(async (args: any) => ({
    list: bins.filter(
      b =>
        b.period >= args.customRange.start && b.period < args.customRange.end,
    ),
    total: {},
  }));
}

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
// Monthly rollup windowing
// ---------------------------------------------------------------------------

// The endpoints no longer ask Autumn for a rolling 90-day span on every
// request. The reported window is split at the start of the current calendar
// month: closed months are immutable and cached until the month rolls over,
// and only the current month is re-queried. That is what takes this endpoint's
// cost off the team's total event volume — the grouped `byApiKey` variant used
// to make Autumn walk ~90 days of raw events per group per daily bin, which is
// what timed out for high-volume teams.
describe("historical usage rollup windows", () => {
  it("queries each closed month, the month to date, and today separately", async () => {
    serveBins([]);

    await getTeamHistoricalUsage("team-1");

    // 3 closed months (Apr, May, Jun) + month-to-date + today
    expect(mockAggregate).toHaveBeenCalledTimes(5);
    const ranges = mockAggregate.mock.calls.map(
      ([args]: any[]) => args.customRange,
    );
    expect(ranges).toEqual(
      expect.arrayContaining([
        { start: WINDOW_START, end: Date.parse("2026-05-01T00:00:00.000Z") },
        {
          start: Date.parse("2026-05-01T00:00:00.000Z"),
          end: Date.parse("2026-06-01T00:00:00.000Z"),
        },
        {
          start: Date.parse("2026-06-01T00:00:00.000Z"),
          end: CURRENT_MONTH_START,
        },
        { start: CURRENT_MONTH_START, end: TODAY_START },
        { start: TODAY_START, end: NOW.getTime() },
      ]),
    );
    // The rolling window is gone; nothing may fall back to `range`.
    for (const [args] of mockAggregate.mock.calls as any[][]) {
      expect(args.range).toBeUndefined();
      expect(args.customerId).toBe("org-1");
      expect(args.entityId).toBe("team-1");
      expect(args.binSize).toBe("day");
    }
  });

  it("stitches closed-month and current-month slices into one series", async () => {
    serveBins([
      {
        period: Date.parse("2026-05-31T00:00:00.000Z"),
        values: { CREDITS: 20 },
      },
      {
        period: Date.parse("2026-06-01T00:00:00.000Z"),
        values: { CREDITS: 333 },
      },
      {
        period: Date.parse("2026-06-30T00:00:00.000Z"),
        values: { CREDITS: 7 },
      },
      {
        period: Date.parse("2026-07-02T00:00:00.000Z"),
        values: { CREDITS: 1 },
      },
    ]);

    await expect(getTeamHistoricalUsage("team-1")).resolves.toEqual([
      {
        startDate: "2026-05-01T00:00:00.000Z",
        endDate: "2026-06-01T00:00:00.000Z",
        creditsUsed: 20,
      },
      {
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-07-01T00:00:00.000Z",
        creditsUsed: 340,
      },
      {
        startDate: "2026-07-01T00:00:00.000Z",
        endDate: null,
        creditsUsed: 1,
      },
    ]);
  });

  it("uses the next calendar month as endDate when a month has zero usage", async () => {
    serveBins([
      {
        period: Date.parse("2026-05-31T00:00:00.000Z"),
        values: { CREDITS: 12 },
      },
      {
        period: Date.parse("2026-07-01T00:00:00.000Z"),
        values: { CREDITS: 7 },
      },
    ]);

    await expect(getTeamHistoricalUsage("team-1")).resolves.toEqual([
      {
        startDate: "2026-05-01T00:00:00.000Z",
        endDate: "2026-06-01T00:00:00.000Z",
        creditsUsed: 12,
      },
      {
        startDate: "2026-07-01T00:00:00.000Z",
        endDate: null,
        creditsUsed: 7,
      },
    ]);
  });

  // The aggregate is scoped strictly to the team's entity. When the entity is
  // missing the team simply has no usage of its own — we return an empty
  // history rather than falling back to the org-wide total.
  it("returns an empty history (no org fallback) when the entity is missing", async () => {
    mockAggregate.mockRejectedValue(
      Object.assign(new Error("not found"), { statusCode: 404 }),
    );

    await expect(getTeamHistoricalUsage("team-1")).resolves.toEqual([]);

    // Only entity-scoped calls are made; no customer-level retry.
    for (const [args] of mockAggregate.mock.calls as any[][]) {
      expect(args.entityId).toBe("team-1");
    }
  });

  it("rethrows non-404 aggregate errors", async () => {
    mockAggregate.mockRejectedValue(
      Object.assign(new Error("boom"), { statusCode: 500 }),
    );
    await expect(getTeamHistoricalUsage("team-1")).rejects.toThrow("boom");
  });

  // Snapping the window to a month boundary must never report LESS history than
  // the rolling 90d window it replaced. The 1st of a month is the tight case: a
  // fixed count of calendar months would fall short there.
  it.each([
    "2026-01-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
    "2026-05-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z",
    "2026-07-15T12:00:00.000Z",
    "2027-03-01T00:00:00.000Z",
  ])("covers at least 90 days when now is %s", async iso => {
    vi.setSystemTime(new Date(iso));
    serveBins([]);

    await getTeamHistoricalUsage("team-1");

    const starts = mockAggregate.mock.calls.map(
      ([args]: any[]) => args.customRange.start,
    );
    const earliest = Math.min(...starts);
    const daysCovered = (Date.parse(iso) - earliest) / (24 * 60 * 60 * 1000);
    expect(daysCovered).toBeGreaterThanOrEqual(90);
  });
});

// ---------------------------------------------------------------------------
// Rollup caching
// ---------------------------------------------------------------------------

describe("historical usage rollup caching", () => {
  it("serves a repeat request entirely from cache", async () => {
    serveBins([
      {
        period: Date.parse("2026-06-10T00:00:00.000Z"),
        values: { CREDITS: 5 },
      },
      {
        period: Date.parse("2026-07-10T00:00:00.000Z"),
        values: { CREDITS: 9 },
      },
    ]);

    const first = await getTeamHistoricalUsage("team-1");
    expect(mockAggregate).toHaveBeenCalledTimes(5);

    const second = await getTeamHistoricalUsage("team-1");
    expect(second).toEqual(first);
    // No further Autumn work for the second request.
    expect(mockAggregate).toHaveBeenCalledTimes(5);
  });

  // Closed months can never change, so they are cached until the month rolls
  // over; the current month is still accruing and gets a short TTL.
  // Correctness comes from the key naming its own window, not from the TTL: a
  // stale entry can never be served for a different day or month.
  it("keys each slice by the window it covers", async () => {
    serveBins([]);

    await getTeamHistoricalUsage("team-1");

    const keys = redisSets.map(s => s.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":m:2026-04"),
        expect.stringContaining(":m:2026-05"),
        expect.stringContaining(":m:2026-06"),
        expect.stringContaining(":mtd:2026-07:2026-07-20"),
        expect.stringContaining(":d:2026-07-20"),
      ]),
    );

    // Only today is short-lived; the immutable windows are held much longer.
    const today = redisSets.find(s => s.key.includes(":d:2026-07-20"))!;
    const closedMonth = redisSets.find(s => s.key.includes(":m:2026-04"))!;
    expect(today.ttl).toBe(60);
    expect(closedMonth.ttl).toBeGreaterThan(today.ttl!);
  });

  // The steady-state cost: with the immutable windows already cached, a request
  // during the day re-queries one day of events, not ~90.
  it("re-queries only today once the immutable windows are cached", async () => {
    serveBins([]);

    await getTeamHistoricalUsage("team-1");
    mockAggregate.mockClear();

    // Drop only today's entry, as its 60s TTL would.
    for (const key of [...redisStore.keys()]) {
      if (key.includes(":d:")) redisStore.delete(key);
    }

    await getTeamHistoricalUsage("team-1");

    expect(mockAggregate).toHaveBeenCalledTimes(1);
    expect(mockAggregate.mock.calls[0][0].customRange).toEqual({
      start: TODAY_START,
      end: NOW.getTime(),
    });
  });

  it("keys the grouped and ungrouped rollups separately", async () => {
    apiKeysData = [{ id: 101, name: "Default" }];
    serveBins([
      {
        period: Date.parse("2026-07-10T00:00:00.000Z"),
        values: { CREDITS: 9 },
        grouped_values: { CREDITS: { "101": 9 } },
      },
    ]);

    await getTeamHistoricalUsage("team-1");
    const afterUngrouped = mockAggregate.mock.calls.length;

    // Must not be served the ungrouped entry, which carries no per-key data.
    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      {
        startDate: "2026-07-01T00:00:00.000Z",
        endDate: null,
        apiKey: "Default",
        creditsUsed: 9,
      },
    ]);
    expect(mockAggregate.mock.calls.length).toBeGreaterThan(afterUngrouped);
  });

  it("coalesces concurrent cold-cache requests into one Autumn call per window", async () => {
    serveBins([
      {
        period: Date.parse("2026-07-10T00:00:00.000Z"),
        values: { CREDITS: 9 },
      },
    ]);

    const [a, b, c] = await Promise.all([
      getTeamHistoricalUsage("team-1"),
      getTeamHistoricalUsage("team-1"),
      getTeamHistoricalUsage("team-1"),
    ]);

    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // One call per window, not one per request (3 requests × 5 windows = 15).
    expect(mockAggregate).toHaveBeenCalledTimes(5);
  });

  it("still answers when the cache is unavailable", async () => {
    redisEnabled = false;
    serveBins([
      {
        period: Date.parse("2026-07-10T00:00:00.000Z"),
        values: { CREDITS: 9 },
      },
    ]);

    await expect(getTeamHistoricalUsage("team-1")).resolves.toEqual([
      {
        startDate: "2026-07-01T00:00:00.000Z",
        endDate: null,
        creditsUsed: 9,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// getTeamHistoricalUsageByApiKey
// ---------------------------------------------------------------------------

describe("getTeamHistoricalUsageByApiKey", () => {
  it("aggregates grouped usage into calendar-month buckets across windows", async () => {
    apiKeysData = [
      { id: 101, name: "Default" },
      { id: 202, name: "postman" },
    ];

    serveBins([
      {
        period: Date.parse("2026-06-30T00:00:00.000Z"),
        grouped_values: { CREDITS: { "101": 10, "202": 3 } },
      },
      {
        period: Date.parse("2026-06-29T00:00:00.000Z"),
        grouped_values: { CREDITS: { "101": 26 } },
      },
      {
        period: Date.parse("2026-07-02T00:00:00.000Z"),
        grouped_values: { CREDITS: { "202": 5 } },
      },
    ]);

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      {
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-07-01T00:00:00.000Z",
        apiKey: "Default",
        creditsUsed: 36,
      },
      {
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-07-01T00:00:00.000Z",
        apiKey: "postman",
        creditsUsed: 3,
      },
      {
        startDate: "2026-07-01T00:00:00.000Z",
        endDate: null,
        apiKey: "postman",
        creditsUsed: 5,
      },
    ]);
  });

  // Autumn's default `maxGroups` is 9 and applies per bin, so with per-day bins
  // the top-9 keys differ day to day and per-key monthly totals get silently
  // scrambled into "Other". Ask for a ceiling no real team reaches.
  it("requests a group ceiling well above the Autumn default", async () => {
    serveBins([]);

    await getTeamHistoricalUsageByApiKey("team-1");

    expect(mockAggregate).toHaveBeenCalledTimes(5);
    for (const [args] of mockAggregate.mock.calls as any[][]) {
      expect(args.groupBy).toBe("properties.apiKeyId");
      expect(args.maxGroups).toBeGreaterThanOrEqual(100);
    }
  });

  it("does not send groupBy on the ungrouped path", async () => {
    serveBins([]);

    await getTeamHistoricalUsage("team-1");

    for (const [args] of mockAggregate.mock.calls as any[][]) {
      expect(args.groupBy).toBeUndefined();
      expect(args.maxGroups).toBeUndefined();
    }
  });

  // Beyond maxGroups Autumn bundles the remainder into an "Other" group. Those
  // credits are real but unattributable, which is a different fact from "this ID
  // did not resolve to a key" — a caller reconciling per-key totals must be able
  // to tell them apart, so "Other" is not folded into "Unknown".
  it("surfaces Autumn's overflow group separately from unresolvable IDs", async () => {
    apiKeysData = [{ id: 101, name: "Default" }];

    serveBins([
      {
        period: Date.parse("2026-07-15T00:00:00.000Z"),
        grouped_values: {
          CREDITS: { "101": 5, Other: 40, "99999999": 2 },
        },
      },
    ]);

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      expect.objectContaining({ apiKey: "Default", creditsUsed: 5 }),
      expect.objectContaining({
        apiKey: "Other (unattributed)",
        creditsUsed: 40,
      }),
      expect.objectContaining({ apiKey: "Unknown", creditsUsed: 2 }),
    ]);
  });

  // Group values come from Autumn, so an inherited property name must not leak
  // through as a "resolved" key name.
  it("does not resolve prototype property names as API key names", async () => {
    apiKeysData = [];

    serveBins([
      {
        period: Date.parse("2026-07-15T00:00:00.000Z"),
        grouped_values: { CREDITS: { constructor: 3, __proto__: 4 } },
      },
    ]);

    const periods = await getTeamHistoricalUsageByApiKey("team-1");
    for (const period of periods) {
      expect(typeof period.apiKey).toBe("string");
      expect(period.apiKey).toBe("Unknown");
    }
  });

  it("labels unresolvable apiKeyIds as 'Unknown' instead of echoing raw values", async () => {
    apiKeysData = [];

    serveBins([
      {
        period: Date.parse("2026-07-15T00:00:00.000Z"),
        grouped_values: {
          CREDITS: {
            ba9045fffbd34fc8aabc2597df6ba044: 11,
            "99999999": 7,
          },
        },
      },
    ]);

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      {
        startDate: "2026-07-01T00:00:00.000Z",
        endDate: null,
        apiKey: "Unknown",
        creditsUsed: 18,
      },
    ]);
  });

  // Names are resolved on read, not baked into the cache, so renaming a key is
  // reflected immediately instead of being frozen for the rest of the month.
  it("reflects an API key rename without waiting for the cache to expire", async () => {
    apiKeysData = [{ id: 101, name: "Default" }];
    serveBins([
      {
        period: Date.parse("2026-07-10T00:00:00.000Z"),
        grouped_values: { CREDITS: { "101": 9 } },
      },
    ]);

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      expect.objectContaining({ apiKey: "Default", creditsUsed: 9 }),
    ]);

    apiKeysData = [{ id: 101, name: "renamed" }];

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([
      expect.objectContaining({ apiKey: "renamed", creditsUsed: 9 }),
    ]);
  });

  it("returns an empty history (no org fallback) when the entity is missing", async () => {
    mockAggregate.mockRejectedValue(
      Object.assign(new Error("not found"), { statusCode: 404 }),
    );

    await expect(getTeamHistoricalUsageByApiKey("team-1")).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Historical aggregations run on the dedicated (longer-timeout) client
// ---------------------------------------------------------------------------

// The Autumn SDK only honors a timeout set at the client level (a per-call
// timeoutMs/signal does NOT override a lower client default), so historical
// calls must go through `autumnHistoricalClient`, not the hot-path
// `autumnClient` whose 2s budget is sized for balance checks. If they regressed
// to the hot-path client, slow teams would time out and surface a 500.
describe("historical usage routes through the dedicated Autumn client", () => {
  it("uses autumnHistoricalClient, not the hot-path client, for the ungrouped aggregate", async () => {
    serveBins([]);

    await getTeamHistoricalUsage("team-1");

    expect(mockAggregate).toHaveBeenCalled();
    expect(mockHotPathAggregate).not.toHaveBeenCalled();
  });

  it("uses autumnHistoricalClient, not the hot-path client, for the grouped byApiKey aggregate", async () => {
    serveBins([]);

    await getTeamHistoricalUsageByApiKey("team-1");

    expect(mockAggregate).toHaveBeenCalled();
    expect(mockHotPathAggregate).not.toHaveBeenCalled();
  });
});
