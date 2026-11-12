import { getZdrPolicy, resolveZdrPolicy } from "./zdr-policy";

describe("resolveZdrPolicy", () => {
  it("is disabled everywhere without flags", () => {
    const policy = resolveZdrPolicy(undefined);
    expect(policy.scrape).toBe("disabled");
    expect(policy.search).toBe("disabled");
    expect(policy.searchForcedKind).toBeNull();
    expect(policy.scrapeZDR(undefined)).toBe(false);
  });

  it("keeps scrape and search independent", () => {
    const scrapeOnly = resolveZdrPolicy({ scrapeZDR: "forced" });
    expect(scrapeOnly.scrape).toBe("forced");
    expect(scrapeOnly.search).toBe("disabled");
    expect(scrapeOnly.searchForcedKind).toBeNull();

    const searchOnly = resolveZdrPolicy({ searchZDR: "forced-anon" });
    expect(searchOnly.scrape).toBe("disabled");
    expect(searchOnly.search).toBe("forced-anon");
    expect(searchOnly.searchForcedKind).toBe("anon");
  });

  it("treats legacy forceZDR as forced for both", () => {
    const policy = resolveZdrPolicy({ forceZDR: true });
    expect(policy.scrape).toBe("forced");
    expect(policy.search).toBe("forced-zdr");
    expect(policy.searchForcedKind).toBe("zdr");
  });

  it("honours only a literal true opt-in", () => {
    const policy = resolveZdrPolicy({ scrapeZDR: "allowed" });
    expect(policy.scrapeZDR(true)).toBe(true);
    expect(policy.scrapeZDR("true")).toBe(false);
    expect(policy.scrapeZDR(undefined)).toBe(false);
    expect(resolveZdrPolicy({ scrapeZDR: "forced" }).scrapeZDR(false)).toBe(
      true,
    );
  });

  it("is frozen", () => {
    const policy = resolveZdrPolicy({ scrapeZDR: "forced" });
    expect(Object.isFrozen(policy)).toBe(true);
  });
});

describe("getZdrPolicy", () => {
  it("returns the policy attached by authMiddleware", () => {
    const zdrPolicy = resolveZdrPolicy({ scrapeZDR: "forced" });
    expect(getZdrPolicy({ zdrPolicy, acuc: { flags: null } })).toBe(zdrPolicy);
  });

  it("resolves from the team flags when none is attached", () => {
    expect(
      getZdrPolicy({ acuc: { flags: { searchZDR: "forced-zdr" } } }).search,
    ).toBe("forced-zdr");
    expect(getZdrPolicy({}).scrape).toBe("disabled");
  });
});
