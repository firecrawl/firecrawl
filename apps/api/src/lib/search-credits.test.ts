import {
  resolveSearchCostPerTenResults,
  searchCreditsForResults,
} from "./search-credits";

describe("resolveSearchCostPerTenResults", () => {
  it("uses the flag when it holds a usable rate", () => {
    expect(
      resolveSearchCostPerTenResults({ searchCostPerTenResults: 2.5 }, false),
    ).toBe(2.5);
    expect(
      resolveSearchCostPerTenResults({ searchCostPerTenResults: 2.5 }, true),
    ).toBe(2.5);
  });

  it("falls back to list price when the flag is absent", () => {
    expect(resolveSearchCostPerTenResults({}, false)).toBe(2);
    expect(resolveSearchCostPerTenResults({}, true)).toBe(10);
    expect(resolveSearchCostPerTenResults(undefined, false)).toBe(2);
    expect(resolveSearchCostPerTenResults(null, true)).toBe(10);
  });

  it("falls back to list price for a garbage flag value", () => {
    const garbage = [
      "2.5",
      "",
      null,
      0,
      -1,
      -2.5,
      NaN,
      Infinity,
      -Infinity,
      {},
      [],
      true,
    ];
    for (const value of garbage) {
      const flags = { searchCostPerTenResults: value } as any;
      expect(resolveSearchCostPerTenResults(flags, false)).toBe(2);
      expect(resolveSearchCostPerTenResults(flags, true)).toBe(10);
    }
  });
});

describe("searchCreditsForResults", () => {
  it("keeps the exact decimal for a fractional rate", () => {
    // 1 block of ten * 2.5 = 2.5
    expect(searchCreditsForResults(10, 2.5)).toBe(2.5);
    // 3 blocks of ten * 2.5 = 7.5
    expect(searchCreditsForResults(30, 2.5)).toBe(7.5);
    // 25 results is 3 blocks of ten, same as 30
    expect(searchCreditsForResults(25, 2.5)).toBe(7.5);
    // A partial block still bills as a full block
    expect(searchCreditsForResults(1, 2.5)).toBe(2.5);
  });

  it("keeps the list price charges unchanged", () => {
    expect(searchCreditsForResults(10, 2)).toBe(2);
    expect(searchCreditsForResults(10, 10)).toBe(10);
    expect(searchCreditsForResults(11, 2)).toBe(4);
  });

  it("charges nothing for no results", () => {
    expect(searchCreditsForResults(0, 2.5)).toBe(0);
    expect(searchCreditsForResults(-5, 2.5)).toBe(0);
  });

  it("never bills a garbage flag as 0 or NaN", () => {
    for (const value of ["2.5", null, 0, -1, NaN] as any[]) {
      const rate = resolveSearchCostPerTenResults(
        { searchCostPerTenResults: value } as any,
        false,
      );
      expect(searchCreditsForResults(10, rate)).toBe(2);
    }
  });
});
