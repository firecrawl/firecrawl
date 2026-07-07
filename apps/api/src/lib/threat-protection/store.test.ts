import {
  resolveEffectivePolicy,
  rowToConfig,
  OrgThreatProtectionConfig,
} from "./store";
import {
  THREAT_PROTECTION_POLICY_DEFAULTS,
  ThreatProtectionPolicy,
} from "./types";

const orgPolicy: ThreatProtectionPolicy = {
  mode: "normal",
  riskScoreThreshold: 60,
  blacklist: ["*.bad.example"],
  whitelist: ["example.com"],
  blockedTlds: ["zip"],
  failurePolicy: "open",
};

function makeOrgConfig(
  overrides: Partial<OrgThreatProtectionConfig> = {},
): OrgThreatProtectionConfig {
  return {
    orgId: "00000000-0000-0000-0000-000000000000",
    policy: { ...orgPolicy },
    allowRequestOverrides: true,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

// =========================================
// rowToConfig — mode column + config jsonb document
// =========================================

const ORG_ID = "00000000-0000-0000-0000-000000000001";

function makeRow(mode: string, config: unknown) {
  return {
    id: "00000000-0000-0000-0000-00000000000a",
    org_id: ORG_ID,
    mode,
    config,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
}

describe("rowToConfig", () => {
  it("maps a full stored document", () => {
    const config = rowToConfig(
      makeRow("normal", {
        riskScoreThreshold: 40,
        blacklist: ["*.bad.example"],
        whitelist: ["example.com"],
        blockedTlds: ["zip"],
        failurePolicy: "open",
        allowRequestOverrides: false,
      }),
    );

    expect(config).toEqual({
      orgId: ORG_ID,
      policy: {
        mode: "normal",
        riskScoreThreshold: 40,
        blacklist: ["*.bad.example"],
        whitelist: ["example.com"],
        blockedTlds: ["zip"],
        failurePolicy: "open",
      },
      allowRequestOverrides: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("falls back to defaults for an empty config document", () => {
    const config = rowToConfig(makeRow("normal", {}));
    expect(config.policy).toEqual({
      mode: "normal",
      ...THREAT_PROTECTION_POLICY_DEFAULTS,
    });
    expect(config.allowRequestOverrides).toBe(true);
  });

  it("ignores unknown keys in the document", () => {
    const config = rowToConfig(
      makeRow("normal", {
        riskScoreThreshold: 10,
        someFutureField: { nested: true },
        deniedCategories: ["Malicious"], // retired field, silently dropped
        siem: { url: "https://siem.example.com" }, // retired field, silently dropped
      }),
    );
    expect(config.policy.riskScoreThreshold).toBe(10);
    expect(config.policy).not.toHaveProperty("deniedCategories");
    expect(config.policy).not.toHaveProperty("someFutureField");
    expect(config).not.toHaveProperty("siem");
  });

  it("fills defaults for a partial document", () => {
    const config = rowToConfig(
      makeRow("normal", { blacklist: ["bad.example"] }),
    );
    expect(config.policy).toEqual({
      mode: "normal",
      ...THREAT_PROTECTION_POLICY_DEFAULTS,
      blacklist: ["bad.example"],
    });
  });

  it("never throws on field-level garbage — bad fields fall back to defaults", () => {
    const config = rowToConfig(
      makeRow("normal", {
        riskScoreThreshold: "not-a-number",
        blacklist: "not-an-array",
        failurePolicy: "sideways",
        allowRequestOverrides: "yes",
      }),
    );
    expect(config.policy).toEqual({
      mode: "normal",
      ...THREAT_PROTECTION_POLICY_DEFAULTS,
    });
    expect(config.allowRequestOverrides).toBe(true);
  });

  it("never throws when the document is not an object at all", () => {
    for (const config of [null, "garbage", 42, ["array"]]) {
      const parsed = rowToConfig(makeRow("normal", config));
      expect(parsed.policy).toEqual({
        mode: "normal",
        ...THREAT_PROTECTION_POLICY_DEFAULTS,
      });
    }
  });

  it("coerces unknown modes (including the retired enhanced) to off", () => {
    expect(rowToConfig(makeRow("off", {})).policy.mode).toBe("off");
    expect(rowToConfig(makeRow("enhanced", {})).policy.mode).toBe("off");
    expect(rowToConfig(makeRow("garbage", {})).policy.mode).toBe("off");
  });
});

describe("resolveEffectivePolicy", () => {
  it("returns mode off with defaults when there is no org config", () => {
    expect(resolveEffectivePolicy(null)).toEqual({
      mode: "off",
      ...THREAT_PROTECTION_POLICY_DEFAULTS,
    });
  });

  it("returns the org policy when there is no request override", () => {
    expect(resolveEffectivePolicy(makeOrgConfig())).toEqual(orgPolicy);
  });

  it("does field-level replacement from the request override", () => {
    const effective = resolveEffectivePolicy(makeOrgConfig(), {
      riskScoreThreshold: 90,
      blockedTlds: ["mov"],
    });
    expect(effective).toEqual({
      ...orgPolicy,
      riskScoreThreshold: 90,
      blockedTlds: ["mov"],
    });
  });

  it("replaces arrays wholesale instead of merging them", () => {
    const effective = resolveEffectivePolicy(makeOrgConfig(), {
      blacklist: ["*.other.example"],
    });
    expect(effective.blacklist).toEqual(["*.other.example"]);
  });

  it("ignores undefined fields in the override", () => {
    const effective = resolveEffectivePolicy(makeOrgConfig(), {
      riskScoreThreshold: undefined,
      failurePolicy: "closed",
    });
    expect(effective.riskScoreThreshold).toBe(60);
    expect(effective.failurePolicy).toBe("closed");
  });

  it("applies overrides on top of defaults when there is no org config", () => {
    const effective = resolveEffectivePolicy(null, {
      mode: "normal",
      riskScoreThreshold: 10,
    });
    expect(effective).toEqual({
      mode: "normal",
      ...THREAT_PROTECTION_POLICY_DEFAULTS,
      riskScoreThreshold: 10,
    });
  });

  it("ignores the override when the org disables request overrides", () => {
    const effective = resolveEffectivePolicy(
      makeOrgConfig({ allowRequestOverrides: false }),
      { mode: "off", riskScoreThreshold: 0 },
    );
    expect(effective).toEqual(orgPolicy);
  });

  it("does not mutate the org config", () => {
    const orgConfig = makeOrgConfig();
    resolveEffectivePolicy(orgConfig, { riskScoreThreshold: 1 });
    expect(orgConfig.policy).toEqual(orgPolicy);
  });
});
