import { describe, expect, it } from "vitest";
import { searchRequestSchema } from "./types";

describe("searchRequestSchema defaults", () => {
  it("keeps search defaults without task context fields", () => {
    const request = searchRequestSchema.parse({
      query: "React memo docs",
    });

    expect(request).toMatchObject({
      query: "React memo docs",
      limit: 10,
    });
    expect(request).not.toHaveProperty("objective");
    expect(request).not.toHaveProperty("clientModel");
  });

  it("rejects unknown sources", () => {
    expect(
      searchRequestSchema.safeParse({
        query: "records",
        sources: ["not-a-source"],
      }).success,
    ).toBe(false);
  });

  it.each([
    { clientModel: "claude-sonnet-4-6" },
    { clientModel: " " },
    { clientModel: "x".repeat(129) },
    { clientModel: 42 },
  ])("rejects removed client model in the request schema %j", context => {
    const result = searchRequestSchema.safeParse({
      query: "React memo docs",
      ...context,
    });

    expect(result.success).toBe(false);
  });

  it.each(["Find official rerender guidance", " ", "x".repeat(5001), null])(
    "rejects objective on search requests: %j",
    objective => {
      expect(
        searchRequestSchema.safeParse({ query: "React memo docs", objective })
          .success,
      ).toBe(false);
    },
  );
});

describe("searchRequestSchema geo targeting", () => {
  it.each([
    [{ location: "Greece" }, "gr", "Greece"],
    [{ location: "Mexico City, Mexico" }, "mx", "Mexico City, Mexico"],
    [
      { location: "San Francisco,California,United States" },
      "us",
      "San Francisco,California,United States",
    ],
    [{ country: "gr" }, "gr", "Greece"],
    [{ country: "MX" }, "MX", "Mexico"],
    [
      { country: "gr", location: "Mexico City, Mexico" },
      "gr",
      "Mexico City, Mexico",
    ],
    [{}, "us", undefined],
  ])("resolves %j to country %s and location %s", (geo, country, location) => {
    const request = searchRequestSchema.parse({ query: "gaming blog", ...geo });

    expect(request.country).toBe(country);
    expect(request.location).toBe(location);
    expect(request.sources[0]).toMatchObject({
      type: "web",
      country,
      location,
    });
  });

  it.each([
    [{ location: "San Francisco" }, undefined, "San Francisco"],
    [{ location: "New Mexico" }, undefined, "New Mexico"],
    [{ location: "Atlanta, Georgia" }, undefined, "Atlanta, Georgia"],
    [{ country: "Greece" }, "Greece", undefined],
  ])(
    "leaves %j unresolved when it names no known country",
    (geo, country, location) => {
      const request = searchRequestSchema.parse({
        query: "gaming blog",
        ...geo,
      });

      expect(request.country).toBe(country);
      expect(request.location).toBe(location);
    },
  );
});
