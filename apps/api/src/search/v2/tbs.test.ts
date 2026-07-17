import { parseTbsGranularity } from "./tbs";

describe("parseTbsGranularity", () => {
  it.each(["h", "d", "w", "m", "y"] as const)(
    "parses qdr:%s",
    g => {
      expect(parseTbsGranularity(`qdr:${g}`)).toBe(g);
    },
  );

  it("is case-insensitive", () => {
    expect(parseTbsGranularity("QDR:W")).toBe("w");
  });

  it("trims surrounding whitespace", () => {
    expect(parseTbsGranularity("  qdr:m ")).toBe("m");
  });

  it("accepts a bare granularity letter", () => {
    expect(parseTbsGranularity("y")).toBe("y");
  });

  it("returns undefined for an unknown granularity", () => {
    expect(parseTbsGranularity("qdr:x")).toBeUndefined();
  });

  it("returns undefined for a custom date range (cdr:)", () => {
    expect(
      parseTbsGranularity("cdr:1,cd_min:1/1/2020,cd_max:1/1/2021"),
    ).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(parseTbsGranularity(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseTbsGranularity("")).toBeUndefined();
  });
});
