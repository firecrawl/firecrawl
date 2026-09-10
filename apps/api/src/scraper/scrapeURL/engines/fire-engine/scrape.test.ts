import { safeModeParams } from "./scrape";
import type { ResolvedSafeMode } from "../../../../lib/safe-mode";

const strict: ResolvedSafeMode = {
  lockdown: false,
  checkRobots: true,
  domainControls: true,
  noStealthProxy: true,
  blockOnSiteRestriction: true,
  blockAuthPaths: true,
};

describe("safeModeParams", () => {
  it("sends nothing when Safe Mode is absent", () => {
    expect(safeModeParams(undefined)).toEqual({});
  });

  it("enables Safe Mode and disables site handling under blockOnSiteRestriction", () => {
    expect(safeModeParams(strict)).toEqual({
      safeMode: true,
      safeModePolicies: { useSiteHandling: false },
    });
  });

  it("allows site handling when blockOnSiteRestriction is relaxed", () => {
    expect(
      safeModeParams({ ...strict, blockOnSiteRestriction: false }),
    ).toEqual({
      safeMode: true,
      safeModePolicies: { useSiteHandling: true },
    });
  });
});
