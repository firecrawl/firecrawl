import {
  threatProtectionConfigSchema,
  threatProtectionOverrideSchema,
  threatProtectionPolicySchema,
} from "./config";
import { THREAT_PROTECTION_POLICY_DEFAULTS } from "./types";

describe("threatProtectionPolicySchema", () => {
  it("applies defaults for a minimal document", () => {
    const policy = threatProtectionPolicySchema.parse({ mode: "off" });
    expect(policy).toEqual({
      mode: "off",
      ...THREAT_PROTECTION_POLICY_DEFAULTS,
    });
  });

  it("accepts a full valid document", () => {
    const policy = threatProtectionPolicySchema.parse({
      mode: "normal",
      riskScoreThreshold: 50,
      blacklist: ["bad.example.com", "*.malware.example"],
      whitelist: ["example.com", "*.example.org"],
      blockedTlds: ["zip", "mov"],
      failurePolicy: "open",
    });
    expect(policy.mode).toBe("normal");
    expect(policy.riskScoreThreshold).toBe(50);
    expect(policy.failurePolicy).toBe("open");
  });

  it("rejects an invalid mode", () => {
    expect(() =>
      threatProtectionPolicySchema.parse({ mode: "paranoid" }),
    ).toThrow();
  });

  it('rejects the retired "enhanced" mode', () => {
    expect(() =>
      threatProtectionPolicySchema.parse({ mode: "enhanced" }),
    ).toThrow();
    expect(() =>
      threatProtectionOverrideSchema.parse({ mode: "enhanced" }),
    ).toThrow();
    expect(() =>
      threatProtectionConfigSchema.parse({ mode: "enhanced" }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      threatProtectionPolicySchema.parse({ mode: "off", nope: true }),
    ).toThrow();
  });

  it("rejects retired policy fields as unknown keys", () => {
    for (const retired of [
      { deniedCategories: ["Malicious"] },
      { maxDomainAgeDays: 30 },
      { blockedCountries: ["KP"] },
    ]) {
      expect(() =>
        threatProtectionPolicySchema.parse({ mode: "normal", ...retired }),
      ).toThrow();
      expect(() => threatProtectionOverrideSchema.parse(retired)).toThrow();
    }
  });

  describe("riskScoreThreshold", () => {
    it.each([0, 100, 75])("accepts %d", value => {
      expect(
        threatProtectionPolicySchema.parse({
          mode: "normal",
          riskScoreThreshold: value,
        }).riskScoreThreshold,
      ).toBe(value);
    });

    it.each([-1, 101, 50.5])("rejects %d", value => {
      expect(() =>
        threatProtectionPolicySchema.parse({
          mode: "normal",
          riskScoreThreshold: value,
        }),
      ).toThrow();
    });
  });

  describe("blacklist / whitelist globs", () => {
    it("normalizes case and whitespace", () => {
      const policy = threatProtectionPolicySchema.parse({
        mode: "normal",
        blacklist: ["  Bad.Example.COM ", "*.Evil.Example"],
      });
      expect(policy.blacklist).toEqual(["bad.example.com", "*.evil.example"]);
    });

    it.each([
      "https://example.com",
      "example.com/path",
      "example.com:8080",
      "*.",
      "*",
      "*.*.example.com",
      "foo",
      "ex ample.com",
      "-bad-.example.com",
      "exa_mple.com",
    ])("rejects garbage entry %j with a clear message", entry => {
      expect(() =>
        threatProtectionPolicySchema.parse({
          mode: "normal",
          blacklist: [entry],
        }),
      ).toThrow(/Invalid domain entry/);
    });
  });

  describe("blockedTlds", () => {
    it("accepts and normalizes TLDs", () => {
      const policy = threatProtectionPolicySchema.parse({
        mode: "normal",
        blockedTlds: ["ZIP", " mov "],
      });
      expect(policy.blockedTlds).toEqual(["zip", "mov"]);
    });

    it.each([".zip", "z!p", "co.uk", ""])("rejects %j", entry => {
      expect(() =>
        threatProtectionPolicySchema.parse({
          mode: "normal",
          blockedTlds: [entry],
        }),
      ).toThrow(/Invalid TLD/);
    });
  });
});

describe("threatProtectionConfigSchema", () => {
  it("applies defaults for allowRequestOverrides", () => {
    const config = threatProtectionConfigSchema.parse({ mode: "normal" });
    expect(config.allowRequestOverrides).toBe(true);
  });

  it("rejects the retired siem field", () => {
    expect(() =>
      threatProtectionConfigSchema.parse({
        mode: "normal",
        siem: { url: "https://siem.example.com/ingest" },
      }),
    ).toThrow();
  });
});
