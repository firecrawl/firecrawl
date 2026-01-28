import { describe, it, expect } from "@jest/globals";
import { buildFdwJobsQuery } from "../../lib/fdw/jobs";

describe("buildFdwJobsQuery", () => {
  it("includes required date range and api key filters", () => {
    const { query, queryParams } = buildFdwJobsQuery({
      apiKeyId: 42,
      startDate: new Date("2024-01-01T00:00:00Z"),
      endDate: new Date("2024-01-02T00:00:00Z"),
      limit: 100,
      offset: 0,
    });

    expect(query).toContain("r.api_key_id = {apiKeyId: UInt64}");
    expect(query).toContain("r.created_at >= {startDate: String}");
    expect(query).toContain("r.created_at <= {endDate: String}");
    expect(queryParams.apiKeyId).toBe(42);
  });

  it("adds mode filter when provided", () => {
    const { queryParams } = buildFdwJobsQuery({
      apiKeyId: 1,
      startDate: new Date("2024-01-01T00:00:00Z"),
      endDate: new Date("2024-01-02T00:00:00Z"),
      limit: 50,
      offset: 0,
      mode: "scrape",
    });

    expect(queryParams).toHaveProperty("modeFilter", "scrape");
  });

  it("uses uuid search condition for uuid input", () => {
    const { query } = buildFdwJobsQuery({
      apiKeyId: 1,
      startDate: new Date("2024-01-01T00:00:00Z"),
      endDate: new Date("2024-01-02T00:00:00Z"),
      limit: 50,
      offset: 0,
      search: "9d9c6d5b-7a93-4a63-9b4d-8d8f031c7c9a",
    });

    expect(query).toContain("r.id = toUUID({searchQuery: String})");
    expect(query).toContain("FROM public_scrapes");
  });

  it("uses substring search condition for non-uuid input", () => {
    const { query } = buildFdwJobsQuery({
      apiKeyId: 1,
      startDate: new Date("2024-01-01T00:00:00Z"),
      endDate: new Date("2024-01-02T00:00:00Z"),
      limit: 50,
      offset: 0,
      search: "example.com",
    });

    expect(query).toContain(
      "positionCaseInsensitive(r.target_hint, {searchQuery: String}) > 0",
    );
  });
});
