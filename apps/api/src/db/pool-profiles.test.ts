import { resolveDbPoolOptions } from "./pool-profiles";

describe("resolveDbPoolOptions connect timeout", () => {
  it("fails API index lookups fast", () => {
    expect(
      resolveDbPoolOptions("api", "index", 0).connectionTimeoutMillis,
    ).toBe(3_000);
  });

  it("keeps the profile timeout for every other pool and profile", () => {
    expect(resolveDbPoolOptions("api", "main", 0).connectionTimeoutMillis).toBe(
      15_000,
    );
    expect(
      resolveDbPoolOptions("api", "replica", 0).connectionTimeoutMillis,
    ).toBe(15_000);
    expect(
      resolveDbPoolOptions("worker", "index", 0).connectionTimeoutMillis,
    ).toBe(30_000);
    expect(
      resolveDbPoolOptions("utility", "index", 0).connectionTimeoutMillis,
    ).toBe(30_000);
    expect(
      resolveDbPoolOptions(undefined, "index", 0).connectionTimeoutMillis,
    ).toBe(0);
  });
});
