import { upgradeLink } from "./upgrade-link";

const TEAM_ID = "3f2c8a1e-5b7d-4c90-9e21-6a4b8d0f1c37";

describe("upgradeLink", () => {
  it("sends a free-plan team to the Hobby checkout for its team", () => {
    expect(upgradeLink(TEAM_ID, { is_paid_plan: false })).toBe(
      `https://www.firecrawl.dev/billing/checkout/hobby?team=${TEAM_ID}`,
    );
  });

  it.each([[{ is_paid_plan: true }], [{}], [null], [undefined]])(
    "keeps the pricing page for a paid or unknown plan (%j)",
    acuc => {
      expect(upgradeLink(TEAM_ID, acuc)).toBe("https://firecrawl.dev/pricing");
    },
  );
});
