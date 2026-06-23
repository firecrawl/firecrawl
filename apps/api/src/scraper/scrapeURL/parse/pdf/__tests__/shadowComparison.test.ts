import {
  comparePdfOutputs,
  extractNumbers,
  countTables,
} from "../shadow-comparison";

describe("extractNumbers", () => {
  it("extracts integers and decimals", () => {
    const nums = extractNumbers("There are 123 items at $45.67 each");
    expect(nums).toEqual(new Set(["123", "45.67"]));
  });

  it("returns empty set for no numbers", () => {
    expect(extractNumbers("no numbers here")).toEqual(new Set());
  });
});

describe("countTables", () => {
  it("counts markdown table separator rows", () => {
    const md = `
| Col A | Col B |
| --- | --- |
| 1 | 2 |

Some text

| X | Y | Z |
| --- | --- | --- |
| a | b | c |
`;
    expect(countTables(md)).toBe(2);
  });

  it("returns 0 when no tables", () => {
    expect(countTables("just some text")).toBe(0);
  });
});

describe("comparePdfOutputs", () => {
  it("identical markdown returns good verdict with ratios of 1", () => {
    const md = "Hello world 123 456";
    const result = comparePdfOutputs(md, md);
    expect(result.overall.lenRatio).toBe(1);
    expect(result.overall.numberPreservationRatio).toBe(1);
    expect(result.overall.overallMatch).toBe("good");
  });

  it("shorter Rust markdown produces correct lenRatio", () => {
    const rustMd = "short";
    const muMd = "this is much longer text";
    const result = comparePdfOutputs(rustMd, muMd);
    expect(result.overall.rustLen).toBe(5);
    expect(result.overall.muLen).toBe(24);
    expect(result.overall.lenRatio).toBeCloseTo(5 / 24, 2);
  });

  it("computes number preservation ratio correctly", () => {
    const muMd = "Values: 123, 456, 789";
    const rustMd = "Values: 123, 789";
    const result = comparePdfOutputs(rustMd, muMd);
    expect(result.overall.muNumberCount).toBe(3);
    expect(result.overall.rustNumberCount).toBe(2);
    expect(result.overall.numberPreservationRatio).toBeCloseTo(2 / 3, 2);
  });

  it("detects table count differences", () => {
    const muMd = `
| A | B |
| --- | --- |
| 1 | 2 |

| C | D |
| --- | --- |
| 3 | 4 |
`;
    const rustMd = `
| A | B |
| --- | --- |
| 1 | 2 |
`;
    const result = comparePdfOutputs(rustMd, muMd);
    expect(result.overall.rustTableCount).toBe(1);
    expect(result.overall.muTableCount).toBe(2);
  });

  it("handles empty inputs", () => {
    const result = comparePdfOutputs("", "");
    expect(result.overall.rustLen).toBe(0);
    expect(result.overall.muLen).toBe(0);
    expect(result.overall.lenRatio).toBe(1);
    expect(result.overall.numberPreservationRatio).toBe(1);
    expect(result.overall.overallMatch).toBe("good");
  });

  it("handles empty Rust with non-empty MU", () => {
    const result = comparePdfOutputs("", "some content 123");
    expect(result.overall.lenRatio).toBe(0);
    expect(result.overall.numberPreservationRatio).toBe(0);
    expect(result.overall.overallMatch).toBe("poor");
  });

  it("returns acceptable verdict at threshold", () => {
    // Target: lenRatio in [0.5, 0.8), numberPreservation in [0.7, 0.9)
    // MU: 20 chars, 10 numbers. Rust: 10 chars (ratio 0.5), 8 of 10 numbers (ratio 0.8)
    const muMd = "aaaaaaaaaa 1 2 3 4 5 6 7 8 9 10";
    const rustMd = "aaaaa 1 2 3 4 5 6 7 8";
    const result = comparePdfOutputs(rustMd, muMd);
    expect(result.overall.lenRatio).toBeGreaterThanOrEqual(0.5);
    expect(result.overall.lenRatio).toBeLessThan(0.8);
    expect(result.overall.numberPreservationRatio).toBeGreaterThanOrEqual(0.7);
    expect(result.overall.numberPreservationRatio).toBeLessThan(0.9);
    expect(result.overall.overallMatch).toBe("acceptable");
  });

  it("returns good when lenRatio >= 0.8 and numberPreservation >= 0.9", () => {
    const muMd = "Numbers: 1 2 3 4 5 6 7 8 9 10 end";
    const rustMd = "Numbers: 1 2 3 4 5 6 7 8 9 10 end";
    const result = comparePdfOutputs(rustMd, muMd);
    expect(result.overall.overallMatch).toBe("good");
  });

  it("returns acceptable when lenRatio >= 0.5 and numberPreservation >= 0.7", () => {
    // 10 numbers in MU, 7 preserved in Rust (ratio = 0.7)
    const muMd = "aaaaaaaaaa 1 2 3 4 5 6 7 8 9 10";
    const rustMd = "aaaaaa 1 2 3 4 5 6 7";
    const result = comparePdfOutputs(rustMd, muMd);
    expect(result.overall.numberPreservationRatio).toBeGreaterThanOrEqual(0.7);
    expect(result.overall.lenRatio).toBeGreaterThanOrEqual(0.5);
    // But not both meeting good thresholds
    expect(result.overall.lenRatio).toBeLessThan(0.8);
    expect(result.overall.overallMatch).toBe("acceptable");
  });

  it("returns poor when below acceptable thresholds", () => {
    const muMd = "a]".repeat(100) + " 1 2 3 4 5 6 7 8 9 10";
    const rustMd = "b 1";
    const result = comparePdfOutputs(rustMd, muMd);
    expect(result.overall.overallMatch).toBe("poor");
  });
});
