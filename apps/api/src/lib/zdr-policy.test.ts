import { isScrapeZDR, resolveZDRPolicy } from "./zdr-policy";

describe("resolveZDRPolicy", () => {
  it("is disabled everywhere without flags", () => {
    expect(resolveZDRPolicy(undefined)).toEqual({
      scrape: "disabled",
      search: "disabled",
      searchForcedKind: null,
    });
  });

  it("keeps scrape and search independent", () => {
    expect(
      resolveZDRPolicy({ scrapeZDR: "forced", searchZDR: "forced-anon" }),
    ).toEqual({
      scrape: "forced",
      search: "forced-anon",
      searchForcedKind: "anon",
    });
    expect(resolveZDRPolicy({ searchZDR: "forced-zdr" })).toEqual({
      scrape: "disabled",
      search: "forced-zdr",
      searchForcedKind: "zdr",
    });
  });

  it("maps the legacy forceZDR flag to both forced modes", () => {
    expect(resolveZDRPolicy({ forceZDR: true })).toEqual({
      scrape: "forced",
      search: "forced-zdr",
      searchForcedKind: "zdr",
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(resolveZDRPolicy({ allowZDR: true }))).toBe(true);
  });
});

describe("isScrapeZDR", () => {
  it("is always on when forced", () => {
    const policy = resolveZDRPolicy({ scrapeZDR: "forced" });
    expect(isScrapeZDR(policy, undefined)).toBe(true);
    expect(isScrapeZDR(policy, false)).toBe(true);
  });

  it("follows the request opt-in when allowed", () => {
    const policy = resolveZDRPolicy({ scrapeZDR: "allowed" });
    expect(isScrapeZDR(policy, true)).toBe(true);
    expect(isScrapeZDR(policy, false)).toBe(false);
    expect(isScrapeZDR(policy, undefined)).toBe(false);
  });

  it("ignores the opt-in when disabled", () => {
    expect(isScrapeZDR(resolveZDRPolicy(undefined), true)).toBe(false);
  });
});
