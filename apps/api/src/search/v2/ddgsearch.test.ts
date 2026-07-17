import { tbsToDdgDf } from "./ddgsearch";

describe("tbsToDdgDf", () => {
  it("maps qdr:h to d (DuckDuckGo has no hour filter)", () => {
    expect(tbsToDdgDf("qdr:h")).toBe("d");
  });
  it("maps qdr:d to d", () => {
    expect(tbsToDdgDf("qdr:d")).toBe("d");
  });
  it("maps qdr:w to w", () => {
    expect(tbsToDdgDf("qdr:w")).toBe("w");
  });
  it("maps qdr:m to m", () => {
    expect(tbsToDdgDf("qdr:m")).toBe("m");
  });
  it("maps qdr:y to y", () => {
    expect(tbsToDdgDf("qdr:y")).toBe("y");
  });
  it("is case-insensitive", () => {
    expect(tbsToDdgDf("QDR:M")).toBe("m");
  });
  it("trims surrounding whitespace", () => {
    expect(tbsToDdgDf(" qdr:y ")).toBe("y");
  });
  it("accepts a bare granularity letter", () => {
    expect(tbsToDdgDf("w")).toBe("w");
  });
  it("returns undefined for an unknown granularity", () => {
    expect(tbsToDdgDf("qdr:x")).toBeUndefined();
  });
  it("returns undefined for a custom date range (cdr:)", () => {
    expect(
      tbsToDdgDf("cdr:1,cd_min:1/1/2020,cd_max:1/1/2021"),
    ).toBeUndefined();
  });
  it("returns undefined for undefined input", () => {
    expect(tbsToDdgDf(undefined)).toBeUndefined();
  });
});
