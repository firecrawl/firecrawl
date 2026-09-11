import {
  applySafeMode,
  getSafeMode,
  resolveSafeMode,
  ResolvedSafeMode,
  SafeModeConfig,
} from "./safe-mode";

// Every sub-control is polarised so that `true` == the stricter setting.
// Under the org defaults, that means every capability control is `true`
// (strictest), except `lockdown` which defaults off.
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

// The per-capability controls the allowlist relaxes (everything except the
// org-wide lockdown + domainControls gates, which the allowlist never touches).
const RELAXABLE = [
  "enforceRobots",
  "disableStealthProxy",
  "disableAuthentication",
  "disableSiteHandling",
  "exposeWebdriver",
  "useHeadlessUserAgent",
  "disablePlatformSelection",
  "disableCountrySelection",
  "disableAutomaticReferrer",
] as const;

// The allowlisted posture: every relaxable capability flipped to its lenient
// value, lockdown + domainControls untouched.
const allCapabilitiesAllowed: ResolvedSafeMode = {
  ...strict,
  ...Object.fromEntries(RELAXABLE.map(k => [k, false])),
} as ResolvedSafeMode;

describe("getSafeMode", () => {
  it("is false for absent or null flags", () => {
    expect(getSafeMode(undefined)).toBe(false);
    expect(getSafeMode(null)).toBe(false);
    expect(getSafeMode({})).toBe(false);
  });

  it("is true only when the flag is exactly true", () => {
    expect(getSafeMode({ safeMode: true })).toBe(true);
    expect(getSafeMode({ safeMode: false })).toBe(false);
  });
});

describe("resolveSafeMode — org flag off", () => {
  it("resolves to nothing when the request says nothing", () => {
    expect(resolveSafeMode(null, undefined)).toEqual({});
    expect(resolveSafeMode({}, undefined)).toEqual({});
  });

  it("treats safeMode: false as a no-op", () => {
    expect(resolveSafeMode({}, false)).toEqual({});
  });

  it("rejects safeMode: true", () => {
    const result = resolveSafeMode({}, true);
    expect(result.error).toMatch(/not enabled/i);
    expect(result.code).toBe("SAFE_MODE_BLOCKED");
    expect(result.safeMode).toBeUndefined();
  });
});

describe("resolveSafeMode — org flag on", () => {
  const flags = { safeMode: true };

  it("resolves strict defaults with lockdown off", () => {
    expect(resolveSafeMode(flags, undefined)).toEqual({ safeMode: strict });
  });

  it("every capability control defaults to its strictest (true), lockdown off", () => {
    const resolved = resolveSafeMode(flags, undefined).safeMode!;
    expect(resolved.lockdown).toBe(false);
    for (const key of [
      "domainControls",
      ...RELAXABLE,
    ] as (keyof ResolvedSafeMode)[]) {
      expect(resolved[key]).toBe(true);
    }
  });

  it("treats safeMode: true as a redundant affirmation, not an error", () => {
    expect(resolveSafeMode(flags, true).safeMode).toBeDefined();
    expect(resolveSafeMode(flags, true).error).toBeUndefined();
  });

  it("merges partial org config over the defaults", () => {
    const result = resolveSafeMode(
      {
        safeMode: true,
        safeModeConfig: { lockdown: true, disableStealthProxy: false },
      },
      undefined,
    );
    expect(result.safeMode).toEqual({
      ...strict,
      lockdown: true,
      disableStealthProxy: false,
    });
  });

  it("lets the org relax each capability independently", () => {
    for (const key of RELAXABLE) {
      const result = resolveSafeMode(
        { safeMode: true, safeModeConfig: { [key]: false } },
        undefined,
      );
      expect(result.safeMode).toEqual({ ...strict, [key]: false });
    }
  });

  it("lets the org opt into lockdown", () => {
    const result = resolveSafeMode(
      { safeMode: true, safeModeConfig: { lockdown: true } },
      undefined,
    );
    expect(result.safeMode).toEqual({ ...strict, lockdown: true });
  });

  it("rejects a bypass when allowBypassSafeMode is unset or false", () => {
    const configs: (SafeModeConfig | undefined)[] = [
      undefined,
      {},
      { allowBypassSafeMode: false },
    ];
    for (const config of configs) {
      const result = resolveSafeMode(
        { safeMode: true, safeModeConfig: config },
        false,
      );
      expect(result.error).toMatch(/disable Safe Mode/i);
      expect(result.code).toBe("SAFE_MODE_BLOCKED");
      expect(result.safeMode).toBeUndefined();
      expect(result.bypassed).toBeUndefined();
    }
  });

  it("enforces the bypass gate even under org-configured lockdown", () => {
    const result = resolveSafeMode(
      { safeMode: true, safeModeConfig: { lockdown: true } },
      false,
    );
    expect(result.error).toMatch(/disable Safe Mode/i);
    expect(result.code).toBe("SAFE_MODE_BLOCKED");
  });

  it("honors a bypass when allowBypassSafeMode is true", () => {
    const result = resolveSafeMode(
      { safeMode: true, safeModeConfig: { allowBypassSafeMode: true } },
      false,
    );
    expect(result).toEqual({ bypassed: true });
  });

  it("still enforces when allowBypassSafeMode is true but no bypass is requested", () => {
    const result = resolveSafeMode(
      { safeMode: true, safeModeConfig: { allowBypassSafeMode: true } },
      undefined,
    );
    expect(result.safeMode).toBeDefined();
    expect(result.bypassed).toBeUndefined();
  });
});

describe("resolveSafeMode — allowlist", () => {
  const flags = {
    safeMode: true,
    safeModeConfig: { allowlist: ["docs.example.com", "*.trusted.example"] },
  };

  it("relaxes every capability but keeps lockdown + domainControls", () => {
    const result = resolveSafeMode(
      flags,
      undefined,
      "https://docs.example.com/x",
    );
    expect(result.allowlisted).toBe(true);
    expect(result.safeMode).toEqual(allCapabilitiesAllowed);
    // spelled out: nothing enforced/disabled, but the org gates stay
    for (const key of RELAXABLE) {
      expect(result.safeMode![key]).toBe(false);
    }
    expect(result.safeMode!.domainControls).toBe(true);
  });

  it("keeps lockdown on for an allowlisted URL when the org enabled it", () => {
    const result = resolveSafeMode(
      {
        safeMode: true,
        safeModeConfig: { lockdown: true, allowlist: ["docs.example.com"] },
      },
      undefined,
      "https://docs.example.com/x",
    );
    expect(result.allowlisted).toBe(true);
    expect(result.safeMode?.lockdown).toBe(true);
    expect(result.safeMode?.disableStealthProxy).toBe(false);
  });

  it("matches globs and subdomains", () => {
    expect(
      resolveSafeMode(flags, undefined, "https://a.trusted.example/p")
        .allowlisted,
    ).toBe(true);
    expect(
      resolveSafeMode(
        { safeMode: true, safeModeConfig: { allowlist: ["example.com"] } },
        undefined,
        "https://sub.example.com/p",
      ).allowlisted,
    ).toBe(true);
  });

  it("does not exempt a non-matching URL — capabilities stay strict", () => {
    const result = resolveSafeMode(flags, undefined, "https://other.example/x");
    expect(result.allowlisted).toBeUndefined();
    expect(result.safeMode?.disableStealthProxy).toBe(true);
  });

  it("ignores the allowlist when no url is passed", () => {
    const result = resolveSafeMode(flags, undefined);
    expect(result.allowlisted).toBeUndefined();
    expect(result.safeMode?.disableAuthentication).toBe(true);
  });

  it("a request bypass still wins over the allowlist path", () => {
    const result = resolveSafeMode(
      {
        safeMode: true,
        safeModeConfig: { allowBypassSafeMode: true, allowlist: ["x.example"] },
      },
      false,
      "https://y.example/p",
    );
    expect(result.bypassed).toBe(true);
  });
});

describe("applySafeMode", () => {
  it("forces auto to basic when stealth proxy is disabled", () => {
    const options = { proxy: "auto" as const };
    applySafeMode(strict, options);
    expect(options.proxy).toBe("basic");
  });

  it("leaves proxy untouched for non-auto values, allowed stealth, or lockdown", () => {
    for (const [safeMode, proxy] of [
      [strict, "basic"],
      [{ ...strict, disableStealthProxy: false }, "auto"],
      [{ ...strict, lockdown: true }, "auto"],
      [undefined, "auto"],
    ] as const) {
      const options = { proxy: proxy as "basic" | "auto" };
      applySafeMode(safeMode, options);
      expect(options.proxy).toBe(proxy);
    }
  });

  it("forces lockdown and the 2-year maxAge when unset", () => {
    const options: { lockdown?: boolean; maxAge?: number } = {};
    applySafeMode({ ...strict, lockdown: true }, options);
    expect(options.lockdown).toBe(true);
    expect(options.maxAge).toBe(2 * 365 * 24 * 60 * 60 * 1000);
  });

  it("keeps a request-supplied maxAge under forced lockdown", () => {
    const options = { maxAge: 5000 };
    applySafeMode({ ...strict, lockdown: true }, options);
    expect(options).toEqual({ lockdown: true, maxAge: 5000 });
  });

  it("no-ops lockdown when already requested or off", () => {
    const alreadyOn = { lockdown: true };
    applySafeMode({ ...strict, lockdown: true }, alreadyOn);
    expect(alreadyOn).toEqual({ lockdown: true });

    const off: { lockdown?: boolean } = {};
    applySafeMode(strict, off);
    applySafeMode(undefined, off);
    expect(off).toEqual({});
  });
});
