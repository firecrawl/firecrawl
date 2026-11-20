import { describe, expect, it, vi } from "vitest";

// These imports belong to fetchRobotsTxt; policy checks use the real parser.
vi.mock("../controllers/v2/types", () => ({ scrapeOptions: {} }));
vi.mock("../scraper/scrapeURL", () => ({ scrapeURL: vi.fn() }));
vi.mock("../scraper/scrapeURL/engines/fire-engine/available", () => ({
  useFireEngine: false,
}));
vi.mock("./cost-tracking", () => ({ CostTracking: class {} }));
vi.mock("../services", () => ({ useIndex: false }));

import { createRobotsChecker, isUrlAllowedByRobots } from "./robots-txt";

const origin = "https://example.com";

function checker(rules: string) {
  return createRobotsChecker(origin, `User-agent: *\n${rules}\n`).robots;
}

describe("robots trailing-path checks", () => {
  it.each([
    "/private",
    "/private/",
    "/private?download=1",
    "/private?next=/",
    "/private#details",
    "/private#details/",
    "/private?download=1#details",
  ])("applies a directory disallow rule to %s", path => {
    const robots = checker("Disallow: /private/");
    expect(isUrlAllowedByRobots(origin + path, robots)).toBe(false);
  });

  it("keeps the query when checking a query-specific rule", () => {
    const robots = checker("Disallow: /private/?token=blocked$");
    expect(
      isUrlAllowedByRobots(origin + "/private?token=blocked#section", robots),
    ).toBe(false);
    expect(
      isUrlAllowedByRobots(origin + "/private?token=allowed#section", robots),
    ).toBe(true);
  });

  it("does not append a slash to a query value", () => {
    const robots = checker("Disallow: /download?file=report/$");
    expect(isUrlAllowedByRobots(origin + "/download?file=report", robots)).toBe(
      true,
    );
    expect(
      isUrlAllowedByRobots(origin + "/download?file=report/", robots),
    ).toBe(false);
  });

  it("honors an allow exception on the directory URL", () => {
    const robots = checker("Disallow: /private/\nAllow: /private/?preview=1$");
    expect(isUrlAllowedByRobots(origin + "/private?preview=1", robots)).toBe(
      true,
    );
  });

  it.each(["/public?download=1", "/private-file?download=1", "/?next=/"])(
    "keeps unrelated paths allowed: %s",
    path => {
      expect(
        isUrlAllowedByRobots(origin + path, checker("Disallow: /private/")),
      ).toBe(true);
    },
  );

  it("does not add a second slash when the path already ends in one", () => {
    const robots = checker("Disallow: /private//");
    expect(isUrlAllowedByRobots(origin + "/private/?download=1", robots)).toBe(
      true,
    );
  });

  it("preserves an encoded query and fragment in the alternate check", () => {
    const robots = checker("Disallow: /private/");
    const isAllowed = vi.spyOn(robots, "isAllowed");
    isUrlAllowedByRobots(
      origin + "/private?next=%2Fdocs%3Fa%3D1#part?nested",
      robots,
      ["custom-agent"],
    );
    expect(isAllowed.mock.calls).toEqual([
      [origin + "/private?next=%2Fdocs%3Fa%3D1#part?nested", "custom-agent"],
      [origin + "/private/?next=%2Fdocs%3Fa%3D1#part?nested", "custom-agent"],
    ]);
  });

  it("keeps the missing-robots fallback", () => {
    expect(isUrlAllowedByRobots(origin + "/private?x=1", null)).toBe(true);
    expect(isUrlAllowedByRobots(origin + "/private?x=1", checker(""))).toBe(
      true,
    );
  });
});
