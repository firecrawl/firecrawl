// Avoid Jest ESM-parse issues on the transitive `uuid` import from NuQ.
jest.mock("uuid", () => ({
  v5: (value: string) => `normalized-${value}`,
  validate: (value: string) => value.startsWith("uuid-"),
}));

import {
  getCrawlStatusExpiresAt,
  isCrawlStatusVisibleToTeam,
} from "../crawl-status-utils";

type TestGroup = Parameters<typeof isCrawlStatusVisibleToTeam>[0]["group"];

function groupForTeam(
  teamId: string,
  overrides: Partial<TestGroup> = {},
): TestGroup {
  return {
    id: "019b0000-0000-7000-8000-000000000001",
    status: "active",
    createdAt: new Date("2026-05-22T00:00:00.000Z"),
    ownerId: `normalized-${teamId}`,
    ttl: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("crawl status utilities", () => {
  it("treats a crawl group owned by the team as visible before crawl metadata or child jobs are visible", () => {
    expect(
      isCrawlStatusVisibleToTeam({
        group: groupForTeam("team_123"),
        groupAnyJob: null,
        storedCrawl: null,
        teamId: "team_123",
      }),
    ).toBe(true);
  });

  it("treats crawl metadata owned by the team as visible before the group is visible", () => {
    expect(
      isCrawlStatusVisibleToTeam({
        group: null,
        groupAnyJob: null,
        storedCrawl: { team_id: "team_123" },
        teamId: "team_123",
      }),
    ).toBe(true);
  });

  it("does not expose a group owned by another team unless existing job/crawl checks pass", () => {
    expect(
      isCrawlStatusVisibleToTeam({
        group: groupForTeam("team_123"),
        groupAnyJob: null,
        storedCrawl: null,
        teamId: "team_other",
      }),
    ).toBe(false);

    expect(
      isCrawlStatusVisibleToTeam({
        group: groupForTeam("team_123"),
        groupAnyJob: null,
        storedCrawl: { team_id: "team_other" },
        teamId: "team_other",
      }),
    ).toBe(true);
  });

  it("falls back to the NuQ group expiry when crawl metadata is not visible yet", () => {
    const group = groupForTeam("team_123", {
      createdAt: new Date("2026-05-22T00:00:00.000Z"),
      ttl: 60_000,
    });

    expect(
      getCrawlStatusExpiresAt({ group, redisExpiry: null }).toISOString(),
    ).toBe("2026-05-22T00:01:00.000Z");
  });
});
