import { checkPermissions } from "./permissions";
import { ResolvedSafeMode } from "./safe-mode";

const strictSafeMode: ResolvedSafeMode = {
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

describe("checkPermissions — safe mode", () => {
  it("passes untouched requests through", () => {
    expect(checkPermissions({}, null, { safeMode: strictSafeMode })).toEqual(
      {},
    );
  });

  it("does nothing when safe mode is absent", () => {
    expect(
      checkPermissions({ proxy: "stealth" }, null, { safeMode: null }),
    ).toEqual({});
  });

  it.each(["stealth", "enhanced"])(
    "rejects %s proxy when stealth proxy is not allowed",
    proxy => {
      const result = checkPermissions({ proxy }, null, {
        safeMode: strictSafeMode,
      });
      expect(result.error).toMatch(/prox/i);
      expect(result.code).toBe("SAFE_MODE_BLOCKED");
    },
  );

  it("allows stealth when useStealthProxy is on", () => {
    expect(
      checkPermissions({ proxy: "stealth" }, null, {
        safeMode: { ...strictSafeMode, useStealthProxy: true },
      }),
    ).toEqual({});
  });

  it("rejects ignoreRobotsTxt even when the org flag would allow it", () => {
    const result = checkPermissions(
      { crawlerOptions: { ignoreRobotsTxt: true } },
      { ignoreRobots: "allowed" },
      { safeMode: strictSafeMode },
    );
    expect(result.code).toBe("SAFE_MODE_BLOCKED");
  });

  it("rejects profile, login actions, and credential headers", () => {
    const requests: Parameters<typeof checkPermissions>[0][] = [
      { profile: { name: "p" } },
      { actions: [{ type: "press" }] },
      { headers: { AUTHORIZATION: "x" } },
      { headers: { "Proxy-Authorization": "x" } },
    ];
    for (const request of requests) {
      const result = checkPermissions(request, null, {
        safeMode: strictSafeMode,
      });
      expect(result.code).toBe("SAFE_MODE_BLOCKED");
    }
  });

  it("allows benign actions and headers", () => {
    expect(
      checkPermissions(
        {
          actions: [{ type: "scroll" }, { type: "screenshot" }],
          headers: { "User-Agent": "test" },
        },
        null,
        { safeMode: strictSafeMode },
      ),
    ).toEqual({});
  });

  it("treats threat protection as forced under domainControls", () => {
    const result = checkPermissions(
      { threatProtection: { mode: "off" } },
      { threatProtection: "allowed" },
      { safeMode: strictSafeMode },
    );
    expect(result.error).toMatch(/cannot be disabled|disable/i);

    const noFlag = checkPermissions(
      { threatProtection: { mode: "off" } },
      null,
      { safeMode: { ...strictSafeMode, lockdown: true } },
    );
    expect(noFlag.error).toBeDefined();

    expect(
      checkPermissions({ threatProtection: { mode: "normal" } }, null, {
        safeMode: strictSafeMode,
      }),
    ).toEqual({});
  });

  it("skips every rule under effective lockdown", () => {
    expect(
      checkPermissions(
        {
          proxy: "stealth",
          profile: { name: "p" },
          actions: [{ type: "write" }],
          headers: { Cookie: "x" },
        },
        null,
        { safeMode: { ...strictSafeMode, lockdown: true } },
      ),
    ).toEqual({});
  });
});

describe("checkPermissions — threat protection", () => {
  const requestWithOption = { threatProtection: { mode: "normal" } };

  it("allows requests without a threatProtection option regardless of flags", () => {
    expect(checkPermissions({}, null)).toEqual({});
    expect(checkPermissions({}, { threatProtection: "disabled" })).toEqual({});
  });

  it("rejects a per-request option when the flag is missing or disabled", () => {
    expect(checkPermissions(requestWithOption, null).error).toMatch(
      /enterprise feature/,
    );
    expect(
      checkPermissions(requestWithOption, { threatProtection: "disabled" })
        .error,
    ).toMatch(/enterprise feature/);
  });

  it.each(["allowed", "forced"] as const)(
    "allows a per-request option when the flag is %s",
    mode => {
      expect(
        checkPermissions(requestWithOption, { threatProtection: mode }),
      ).toEqual({});
    },
  );

  it("rejects a per-request option when the org disables overrides", () => {
    const result = checkPermissions(
      requestWithOption,
      { threatProtection: "allowed" },
      { threatProtectionOrgConfig: { allowRequestOverrides: false } },
    );
    expect(result.error).toMatch(/overrides are disabled/);
  });

  it("allows a per-request option when the org config allows overrides", () => {
    expect(
      checkPermissions(
        requestWithOption,
        { threatProtection: "allowed" },
        { threatProtectionOrgConfig: { allowRequestOverrides: true } },
      ),
    ).toEqual({});
    expect(
      checkPermissions(
        requestWithOption,
        { threatProtection: "allowed" },
        { threatProtectionOrgConfig: null },
      ),
    ).toEqual({});
  });
});
