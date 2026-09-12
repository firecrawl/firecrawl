import { safeModeParams } from "./scrape";
import type { ResolvedSafeMode } from "../../../../lib/safe-mode";

const strict: ResolvedSafeMode = {
  lockdown: false,
  domainControls: true,
  enforceRobots: true,
  disableStealthProxy: true,
  disableAuthentication: true,
  disableSiteHandling: true,
  exposeWebdriver: true,
  useHeadlessUserAgent: true,
  disablePlatformSelection: true,
  disableCountrySelection: true,
  disableAutomaticReferrer: true,
};

// The safe-mode control -> engine behaviorOverride field it drives. Same
// name, same value: the mapper is a straight pass-through (no negation).
const ENGINE_FIELDS = [
  "disableSiteHandling",
  "exposeWebdriver",
  "useHeadlessUserAgent",
  "disablePlatformSelection",
  "disableCountrySelection",
  "disableAutomaticReferrer",
] as const;

describe("safeModeParams", () => {
  it("sends nothing when Safe Mode is absent", () => {
    expect(safeModeParams(undefined)).toEqual({});
  });

  it("passes the strict defaults through as all overrides on", () => {
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

  it("only forwards the six engine fields, not the firecrawl-side controls", () => {
    expect(Object.keys(safeModeParams(strict).behaviorOverrides!)).toEqual([
      ...ENGINE_FIELDS,
    ]);
  });

  it("forwards each engine field verbatim, with no negation", () => {
    for (const field of ENGINE_FIELDS) {
      const relaxed = safeModeParams({ ...strict, [field]: false });
      expect(relaxed.behaviorOverrides![field]).toBe(false);
      // the other five stay on
      for (const other of ENGINE_FIELDS) {
        if (other !== field) {
          expect(relaxed.behaviorOverrides![other]).toBe(true);
        }
      }
    }
  });

  it("passes an allowlisted (fully relaxed) posture through as all overrides off", () => {
    const relaxed: ResolvedSafeMode = {
      ...strict,
      disableSiteHandling: false,
      exposeWebdriver: false,
      useHeadlessUserAgent: false,
      disablePlatformSelection: false,
      disableCountrySelection: false,
      disableAutomaticReferrer: false,
    };
    expect(safeModeParams(relaxed)).toEqual({
      behaviorOverrides: {
        disableSiteHandling: false,
        exposeWebdriver: false,
        useHeadlessUserAgent: false,
        disablePlatformSelection: false,
        disableCountrySelection: false,
        disableAutomaticReferrer: false,
      },
    });
  });
});
