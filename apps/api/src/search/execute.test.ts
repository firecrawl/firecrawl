import { describe, expect, it } from "vitest";
import { isSuccessfulScrapedResult } from "./result-policy";

describe("search scrape result policy", () => {
  it("accepts successfully scraped content", () => {
    expect(
      isSuccessfulScrapedResult({
        markdown: "# Result",
        metadata: { statusCode: 200 },
      }),
    ).toBe(true);
  });

  it.each([404, 410, 429, 500])("drops status %s", statusCode => {
    expect(isSuccessfulScrapedResult({ metadata: { statusCode } })).toBe(false);
  });

  it("drops explicit scrape errors and empty un-scraped results", () => {
    expect(
      isSuccessfulScrapedResult({
        metadata: { statusCode: 200, error: "challenge page" },
      }),
    ).toBe(false);
    expect(isSuccessfulScrapedResult({})).toBe(false);
  });
});
