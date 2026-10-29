import { describe, expect, it } from "vitest";
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
});
