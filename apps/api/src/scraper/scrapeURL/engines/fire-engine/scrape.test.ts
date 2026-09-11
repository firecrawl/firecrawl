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

  it("translates strict defaults to all overrides on (block)", () => {
    expect(safeModeParams(strict)).toEqual({
      behaviorOverrides: {
        disableSiteHandling: true,
        exposeWebdriver: true,
        useHeadlessUserAgent: true,
        disablePlatformSelection: true,
        disableCountrySelection: true,
        disableAutomaticReferrer: true,
      },
    });
  });

  it("negates each allowed capability into the engine override", () => {
    expect(
      safeModeParams({
        ...strict,
        useSiteHandling: true,
        useCountrySelection: true,
      }),
    ).toEqual({
      behaviorOverrides: {
        disableSiteHandling: false,
        exposeWebdriver: true,
        useHeadlessUserAgent: true,
        disablePlatformSelection: true,
        disableCountrySelection: false,
        disableAutomaticReferrer: true,
      },
    });
  });
});
