import { describe, expect, it, vi } from "vitest";

vi.mock("@mendable/firecrawl-rs", () => ({ validateRegexes: () => [] }));
import { projectScrapeCredits } from "./keyless-credit-projection";
import { scrapeOptions } from "../controllers/v2/types";

describe("projectScrapeCredits", () => {
  it("projects the prompt injection guard fee on a markdown scrape", () => {
    expect(
      projectScrapeCredits(
        scrapeOptions.parse({ checkPromptInjection: true }),
        null,
        false,
      ),
    ).toBe(5);
  });

  it("projects the guard fee on top of json", () => {
    expect(
      projectScrapeCredits(
        scrapeOptions.parse({
          formats: [
            {
              type: "json",
              schema: { type: "object", properties: {} },
              checkPromptInjection: true,
            },
          ],
        }),
        null,
        false,
      ),
    ).toBe(9);
  });

  it("projects the json surcharge on top of lockdown", () => {
    expect(
      projectScrapeCredits(
        scrapeOptions.parse({
          lockdown: true,
          formats: [
            {
              type: "json",
              schema: { type: "object", properties: {} },
            },
          ],
        }),
        null,
        false,
      ),
    ).toBe(9);
  });
});
