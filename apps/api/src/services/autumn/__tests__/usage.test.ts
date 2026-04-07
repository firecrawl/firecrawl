import { jest } from "@jest/globals";

const mockAggregate = jest.fn<(args: any) => Promise<any>>();

let autumnClientRef: { events: { aggregate: typeof mockAggregate } } | null = {
  events: { aggregate: mockAggregate },
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
  getTeamHistoricalUsage,
  getTeamHistoricalUsageByApiKey,
} from "../usage";

beforeEach(() => {
  jest.clearAllMocks();
  autumnClientRef = { events: { aggregate: mockAggregate } };
  teamLookup = { data: { org_id: "org-1" }, error: null };
  apiKeysData = [];
});

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

    await expect(
      getTeamHistoricalUsage("team-1"),
    ).resolves.toEqual([
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

    await expect(
      getTeamHistoricalUsage("team-1"),
    ).resolves.toEqual([
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

    await expect(
      getTeamHistoricalUsage("team-1"),
    ).resolves.toEqual([
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

    await expect(
      getTeamHistoricalUsageByApiKey("team-1"),
    ).resolves.toEqual([
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

    await expect(
      getTeamHistoricalUsageByApiKey("team-1"),
    ).resolves.toEqual([
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
