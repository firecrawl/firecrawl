import {
  getPDFMaxPages,
  getPDFMode,
  scrapeOptions,
  shouldParsePDF,
} from "../controllers/v2/types";

describe("PDF parser options", () => {
  it("enables pdf by default", () => {
    expect(scrapeOptions.parse({}).parsers).toEqual(["pdf"]);
    expect(shouldParsePDF(undefined)).toBe(true);
    expect(shouldParsePDF(["pdf"])).toBe(true);
  });

  it("opts out with an empty parser list", () => {
    expect(shouldParsePDF([])).toBe(false);
    expect(scrapeOptions.parse({ parsers: [] }).parsers).toEqual([]);
  });

  it("parses pdf mode and maxPages options", () => {
    expect(getPDFMode(["pdf"])).toBe("auto");
    expect(getPDFMode([{ type: "pdf", mode: "fast" }])).toBe("fast");
    expect(getPDFMaxPages([{ type: "pdf", maxPages: 10 }])).toBe(10);
    expect(
      scrapeOptions.parse({
        parsers: [{ type: "pdf", mode: "fast", maxPages: 25 }],
      }).parsers,
    ).toEqual([{ type: "pdf", mode: "fast", maxPages: 25 }]);
  });

  it("rejects unknown parser values", () => {
    expect(scrapeOptions.safeParse({ parsers: ["unknown"] }).success).toBe(
      false,
    );
  });
});
