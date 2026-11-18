import {
  getPolicySearchForcedKind,
  isScrapeZDR,
  resolveZDRPolicy,
} from "./zdr-policy";
import {
  getEffectiveSearchForcedKind,
  isLockdownZeroDataRetention,
} from "./safe-mode";
import { getScrapeZDR } from "./zdr-helpers";
import type { TeamFlags } from "../controllers/v2/types";

describe("resolveZDRPolicy", () => {
  it("is disabled everywhere without flags", () => {
    expect(resolveZDRPolicy(undefined)).toEqual({
      scrape: "disabled",
      search: "disabled",
      searchForcedKind: null,
      lockdown: false,
      lockdownBypassable: false,
    });
  });

  it("keeps scrape and search independent", () => {
    expect(
      resolveZDRPolicy({ scrapeZDR: "forced", searchZDR: "forced-anon" }),
    ).toMatchObject({
      scrape: "forced",
      search: "forced-anon",
      searchForcedKind: "anon",
    });
    expect(resolveZDRPolicy({ searchZDR: "forced-zdr" })).toMatchObject({
      scrape: "disabled",
      search: "forced-zdr",
      searchForcedKind: "zdr",
    });
  });

  it("maps the legacy forceZDR flag to both forced modes", () => {
    expect(resolveZDRPolicy({ forceZDR: true })).toMatchObject({
      scrape: "forced",
      search: "forced-zdr",
      searchForcedKind: "zdr",
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(resolveZDRPolicy({ allowZDR: true }))).toBe(true);
  });
});

describe("isScrapeZDR", () => {
  it("is always on when forced", () => {
    const policy = resolveZDRPolicy({ scrapeZDR: "forced" });
    expect(isScrapeZDR(policy, {})).toBe(true);
    expect(isScrapeZDR(policy, { zeroDataRetention: false })).toBe(true);
  });

  it("follows the request opt-in when allowed", () => {
    const policy = resolveZDRPolicy({ scrapeZDR: "allowed" });
    expect(isScrapeZDR(policy, { zeroDataRetention: true })).toBe(true);
    expect(isScrapeZDR(policy, { zeroDataRetention: false })).toBe(false);
    expect(isScrapeZDR(policy, {})).toBe(false);
  });

  it("ignores the opt-in when disabled", () => {
    expect(
      isScrapeZDR(resolveZDRPolicy(undefined), { zeroDataRetention: true }),
    ).toBe(false);
  });
});

describe("lockdown", () => {
  const cases: [string, TeamFlags][] = [
    ["lockdown", { safeMode: true, safeModeConfig: { lockdown: true } }],
    [
      "bypassable lockdown",
      {
        safeMode: true,
        safeModeConfig: { lockdown: true, allowBypassSafeMode: true },
      },
    ],
    [
      "lockdown with forced anon search",
      {
        safeMode: true,
        safeModeConfig: { lockdown: true },
        searchZDR: "forced-anon",
      },
    ],
    ["safe mode without lockdown", { safeMode: true }],
  ] as [string, TeamFlags][];

  for (const [name, flags] of cases) {
    it(`matches the existing helpers for ${name}`, () => {
      const policy = resolveZDRPolicy(flags);
      for (const safeMode of [undefined, true, false]) {
        expect(isScrapeZDR(policy, { safeMode })).toBe(
          getScrapeZDR(flags) === "forced" ||
            isLockdownZeroDataRetention(flags, safeMode),
        );
        expect(getPolicySearchForcedKind(policy, { safeMode })).toBe(
          getEffectiveSearchForcedKind(flags, safeMode),
        );
      }
    });
  }
});
