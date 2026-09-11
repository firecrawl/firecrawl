import { safeModeParams } from "./scrape";
import type { ResolvedSafeMode } from "../../../../lib/safe-mode";

const strict: ResolvedSafeMode = {
  lockdown: false,
  domainControls: true,
  allowIgnoreRobots: false,
  useStealthProxy: false,
  useAuthentication: false,
  useSiteHandling: false,
  useDefaultAutomation: false,
  useDefaultUserAgent: false,
  usePlatformSelection: false,
  useCountrySelection: false,
  useReferrer: false,
};

describe("safeModeParams", () => {
  it("sends nothing when Safe Mode is absent", () => {
    expect(safeModeParams(undefined)).toEqual({});
  });

  it("forwards all engine policies (all off under strict defaults)", () => {
    expect(safeModeParams(strict)).toEqual({
      safeModePolicies: {
        useSiteHandling: false,
        useDefaultAutomation: false,
        useDefaultUserAgent: false,
        usePlatformSelection: false,
        useCountrySelection: false,
        useReferrer: false,
      },
    });
  });

  it("forwards each engine policy as configured", () => {
    expect(
      safeModeParams({
        ...strict,
        useSiteHandling: true,
        useCountrySelection: true,
      }),
    ).toEqual({
      safeModePolicies: {
        useSiteHandling: true,
        useDefaultAutomation: false,
        useDefaultUserAgent: false,
        usePlatformSelection: false,
        useCountrySelection: true,
        useReferrer: false,
      },
    });
  });
});
