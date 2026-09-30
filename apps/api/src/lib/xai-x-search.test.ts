import { xSearchCost, xSearchUsageFromResponseBody } from "./xai-x-search";

describe("xSearchUsageFromResponseBody", () => {
  it("reads posts and profiles fetched from the Responses usage block", () => {
    expect(
      xSearchUsageFromResponseBody({
        usage: {
          server_side_tool_usage_details: {
            x_search_calls: 2,
            x_posts_fetched: 44,
            x_users_fetched: 3,
          },
        },
      }),
    ).toEqual({ posts: 44, profiles: 3 });
  });

  it("counts a missing field as zero when the other is reported", () => {
    expect(
      xSearchUsageFromResponseBody({
        usage: { server_side_tool_usage_details: { x_posts_fetched: 12 } },
      }),
    ).toEqual({ posts: 12, profiles: 0 });
  });

  it.each([
    ["no body", undefined],
    ["a non-object body", "not json"],
    ["no usage", { id: "resp" }],
    ["no tool usage details", { usage: { input_tokens: 10 } }],
    [
      "no item counts",
      { usage: { server_side_tool_usage_details: { x_search_calls: 1 } } },
    ],
    [
      "invalid item counts",
      {
        usage: {
          server_side_tool_usage_details: {
            x_posts_fetched: "44",
            x_users_fetched: -1,
          },
        },
      },
    ],
    [
      "one valid and one invalid item count",
      {
        usage: {
          server_side_tool_usage_details: {
            x_posts_fetched: 44,
            x_users_fetched: "3",
          },
        },
      },
    ],
  ])("returns undefined for %s", (_, body) => {
    expect(xSearchUsageFromResponseBody(body)).toBeUndefined();
  });
});

describe("xSearchCost", () => {
  it("prices posts at $5 per 1k and profiles at $10 per 1k", () => {
    expect(xSearchCost({ posts: 1000, profiles: 0 })).toBeCloseTo(5, 10);
    expect(xSearchCost({ posts: 0, profiles: 1000 })).toBeCloseTo(10, 10);
    expect(xSearchCost({ posts: 44, profiles: 3 })).toBeCloseTo(0.25, 10);
  });

  it("is zero when nothing was fetched", () => {
    expect(xSearchCost({ posts: 0, profiles: 0 })).toBe(0);
  });
});
