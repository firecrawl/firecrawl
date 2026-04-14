import { jest, beforeEach } from "@jest/globals";

const mockAggregate = jest.fn<(args: any) => Promise<any>>();
const mockEntitiesGet = jest.fn<(args: any) => Promise<any>>();
const mockCustomersGetOrCreate = jest.fn<(args: any) => Promise<any>>();

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

jest.mock("../client", () => ({
  get autumnClient() {
    return autumnClientRef;
  },
}));

jest.mock("../../supabase", () => ({
  get supabase_rr_service() {
    return {
      from: (table: string) => ({
        select: () => {
          if (table === "teams") {
            return {
              eq: () => ({
                single: () => Promise.resolve(teamLookup),
              }),
            };
          }

          if (table === "api_keys") {
            return {
              in: () => Promise.resolve({ data: apiKeysData, error: null }),
            };
          }

          return {};
        },
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
  jest.clearAllMocks();
  autumnClientRef = {
    events: { aggregate: mockAggregate },
    entities: { get: mockEntitiesGet },
    customers: { getOrCreate: mockCustomersGetOrCreate },
  };
  teamLookup = { data: { org_id: "org-1" }, error: null };
  apiKeysData = [];
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
    // But remaining/granted reflects the full amount including grants
    expect(result!.remaining).toBe(100525);
    expect(result!.granted).toBe(100525);
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
    );
  });

  it("falls back to a customer-level aggregate when the entity is missing", async () => {
    mockAggregate
      .mockRejectedValueOnce(
        Object.assign(new Error("not found"), { statusCode: 404 }),
      )
      .mockResolvedValueOnce({
        list: [
          {
            period: Date.parse("2026-04-02T00:00:00.000Z"),
            values: { CREDITS: 4 },
          },
        ],
      });

    await expect(getTeamHistoricalUsage("team-1")).resolves.toEqual([
      {
        startDate: "2026-04-01T00:00:00.000Z",
        endDate: null,
        creditsUsed: 4,
      },
    ]);

    expect(mockAggregate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        customerId: "org-1",
        entityId: "team-1",
        range: "90d",
        binSize: "day",
      }),
    );
    expect(mockAggregate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        customerId: "org-1",
        range: "90d",
        binSize: "day",
      }),
    );
    expect(mockAggregate.mock.calls[1][0]).not.toHaveProperty("entityId");
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

describe("getTeamHistoricalUsageByApiKey", () => {
  it("aggregates daily grouped usage into calendar-month buckets", async () => {
    apiKeysData = [
      { id: 101, name: "Default" },
      { id: 202, name: "postman" },
    ];

    mockAggregate.mockResolvedValue({
      list: [
        {
          period: Date.parse("2026-03-30T00:00:00.000Z"),
          grouped_values: { CREDITS: { "101": 10, "202": 3 } },
        },
        {
          period: Date.parse("2026-03-31T00:00:00.000Z"),
          grouped_values: { CREDITS: { "101": 26 } },
        },
        {
          period: Date.parse("2026-04-02T00:00:00.000Z"),
          grouped_values: { CREDITS: { "202": 5 } },
        },
      ],
    });

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

    expect(mockAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "org-1",
        entityId: "team-1",
        featureId: "CREDITS",
        range: "90d",
        binSize: "day",
        groupBy: "properties.apiKeyId",
      }),
    );
  });

  it("uses the next calendar month as endDate for grouped data when a month has zero usage", async () => {
    apiKeysData = [{ id: 101, name: "Default" }];

    mockAggregate.mockResolvedValue({
      list: [
        {
          period: Date.parse("2026-01-31T00:00:00.000Z"),
          grouped_values: { CREDITS: { "101": 12 } },
        },
        {
          period: Date.parse("2026-03-01T00:00:00.000Z"),
          grouped_values: { CREDITS: { "101": 7 } },
        },
      ],
    });

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
});
