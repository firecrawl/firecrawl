import { describe, expect, it } from "vitest";
import { projectScrapeCredits } from "../keyless-credit-projection";
import { calculateCreditsToBeBilled } from "../scrape-billing";
import { CostTracking } from "../cost-tracking";
import { scrapeOptions } from "../../controllers/v2/types";

// The keyless projection reserves credits before the scrape runs and reconciles
// against what the scrape billed (controllers/v2/scrape.ts). A projection below
// the bill therefore lets a request overrun the IP's daily allowance, so the two
// must agree on every request shape. The projection overwrote the lockdown
// surcharge with the json one, reserving 5 for a request that bills 9.
async function billed(body: Record<string, unknown>): Promise<number> {
  return await calculateCreditsToBeBilled(
    scrapeOptions.parse(body),
    { teamId: "team-id", orgId: null } as any,
    { metadata: { statusCode: 200, proxyUsed: "basic" } } as any,
    new CostTracking(),
    {} as any,
  );
}

describe("projectScrapeCredits against calculateCreditsToBeBilled", () => {
  it("stacks the json premium on top of lockdown instead of replacing it", async () => {
    const body = {
      lockdown: true,
      formats: [{ type: "json", prompt: "extract the price" }],
    };

    // Lockdown implies zero data retention, which bills no extra premium.
    // 1 base + 4 lockdown + 4 json.
    expect(
      projectScrapeCredits(scrapeOptions.parse(body), null as any, true),
    ).toBe(9);
    await expect(billed(body)).resolves.toBe(9);
  });

  it("stacks the json premium on lockdown for change tracking's json mode", async () => {
    const body = {
      lockdown: true,
      formats: [
        { type: "markdown" },
        { type: "changeTracking", modes: ["json"] },
      ],
    };

    expect(
      projectScrapeCredits(scrapeOptions.parse(body), null as any, true),
    ).toBe(9);
    await expect(billed(body)).resolves.toBe(9);
  });

  it("keeps a plain json projection at 5 credits", async () => {
    const body = { formats: [{ type: "json", prompt: "extract the price" }] };

    expect(
      projectScrapeCredits(scrapeOptions.parse(body), null as any, false),
    ).toBe(5);
    await expect(billed(body)).resolves.toBe(5);
  });
});
