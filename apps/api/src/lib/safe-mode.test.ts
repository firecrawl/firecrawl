import {
  applySafeModeLockdown,
  applySafeModeProxyLimit,
  getSafeMode,
  resolveSafeMode,
  ResolvedSafeMode,
  SafeModeConfig,
} from "./safe-mode";

const strict: ResolvedSafeMode = {
  lockdown: false,
  checkRobots: true,
  domainControls: true,
  proxyLimit: "basic",
  noCaptchaBypass: true,
  blockAuthPaths: true,
};

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
    expect(resolveSafeMode(flags, undefined)).toEqual({
      safeMode: {
        lockdown: false,
        checkRobots: true,
        domainControls: true,
        proxyLimit: "basic",
        noCaptchaBypass: true,
        blockAuthPaths: true,
      },
    });
  });

  it("treats safeMode: true as a redundant affirmation, not an error", () => {
    expect(resolveSafeMode(flags, true).safeMode).toBeDefined();
    expect(resolveSafeMode(flags, true).error).toBeUndefined();
  });

  it("merges partial org config over the defaults", () => {
    const result = resolveSafeMode(
      {
        safeMode: true,
        safeModeConfig: { lockdown: true, proxyLimit: "stealth" },
      },
      undefined,
    );
    expect(result.safeMode).toEqual({
      lockdown: true,
      checkRobots: true,
      domainControls: true,
      proxyLimit: "stealth",
      noCaptchaBypass: true,
      blockAuthPaths: true,
    });
  });

  it("rejects a bypass when allowBypass is unset or false", () => {
    const configs: (SafeModeConfig | undefined)[] = [
      undefined,
      {},
      { allowBypass: false },
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

  it("honors a bypass when allowBypass is true", () => {
    const result = resolveSafeMode(
      { safeMode: true, safeModeConfig: { allowBypass: true } },
      false,
    );
    expect(result).toEqual({ bypassed: true });
  });

  it("still enforces when allowBypass is true but no bypass is requested", () => {
    const result = resolveSafeMode(
      { safeMode: true, safeModeConfig: { allowBypass: true } },
      undefined,
    );
    expect(result.safeMode).toBeDefined();
    expect(result.bypassed).toBeUndefined();
  });
});

describe("applySafeModeProxyLimit", () => {
  it("pins auto to basic under a basic limit", () => {
    const options = { proxy: "auto" as const };
    applySafeModeProxyLimit(strict, options);
    expect(options.proxy).toBe("basic");
  });

  it("leaves non-auto values and other configs untouched", () => {
    for (const [safeMode, proxy] of [
      [strict, "basic"],
      [{ ...strict, proxyLimit: "stealth" }, "auto"],
      [{ ...strict, lockdown: true }, "auto"],
      [undefined, "auto"],
    ] as const) {
      const options = { proxy: proxy as "basic" | "auto" };
      applySafeModeProxyLimit(safeMode, options);
      expect(options.proxy).toBe(proxy);
    }
  });
});

describe("applySafeModeLockdown", () => {
  it("forces lockdown and the 2-year maxAge when unset", () => {
    const options: { lockdown?: boolean; maxAge?: number } = {};
    applySafeModeLockdown({ ...strict, lockdown: true }, options);
    expect(options.lockdown).toBe(true);
    expect(options.maxAge).toBe(2 * 365 * 24 * 60 * 60 * 1000);
  });

  it("keeps a request-supplied maxAge", () => {
    const options = { maxAge: 5000 };
    applySafeModeLockdown({ ...strict, lockdown: true }, options);
    expect(options).toEqual({ lockdown: true, maxAge: 5000 });
  });

  it("no-ops when lockdown was already requested or is off", () => {
    const alreadyOn = { lockdown: true };
    applySafeModeLockdown({ ...strict, lockdown: true }, alreadyOn);
    expect(alreadyOn).toEqual({ lockdown: true });

    const off: { lockdown?: boolean } = {};
    applySafeModeLockdown(strict, off);
    applySafeModeLockdown(undefined, off);
    expect(off).toEqual({});
  });
});
