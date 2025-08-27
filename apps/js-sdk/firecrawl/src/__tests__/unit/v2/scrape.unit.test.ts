/**
 * Minimal unit test for v2 scrape (no mocking; sanity check payload path)
 */
import { FirecrawlClient } from "../../../v2/client";

describe("v2.scrape unit", () => {
  test("constructor requires apiKey", () => {
    expect(() => new FirecrawlClient({ apiKey: "", apiUrl: "https://api.firecrawl.dev" })).toThrow();
  });
});

