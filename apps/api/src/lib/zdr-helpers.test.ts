import {
  getAgentZdrRetentionMinutes,
  getAlexandriaZDR,
  isAlexandriaZDRForced,
  isDpaRestricted,
} from "./zdr-helpers";

describe("getAgentZdrRetentionMinutes", () => {
  it("is null when unset", () => {
    expect(getAgentZdrRetentionMinutes(undefined)).toBeNull();
    expect(getAgentZdrRetentionMinutes({})).toBeNull();
  });

  it("returns each tier", () => {
    for (const minutes of [15, 30, 60, 360, 1440]) {
      expect(
        getAgentZdrRetentionMinutes({ agentZdrRetentionMinutes: minutes }),
      ).toBe(minutes);
    }
  });

  it("marks any other value invalid", () => {
    for (const value of [0, 45, 2880, "30" as unknown as number]) {
      expect(
        getAgentZdrRetentionMinutes({ agentZdrRetentionMinutes: value }),
      ).toBe("invalid");
    }
  });
});

describe("isDpaRestricted", () => {
  it("is false when flags are missing", () => {
    expect(isDpaRestricted(undefined)).toBe(false);
    expect(isDpaRestricted(null)).toBe(false);
  });

  it("is false when the flag is absent or not strictly true", () => {
    expect(isDpaRestricted({})).toBe(false);
    expect(isDpaRestricted({ dpaRestricted: false })).toBe(false);
    expect(
      isDpaRestricted({ dpaRestricted: "true" as unknown as boolean }),
    ).toBe(false);
  });

  it("is true when the flag is set", () => {
    expect(isDpaRestricted({ dpaRestricted: true })).toBe(true);
  });
});

describe("getAlexandriaZDR", () => {
  it("is forced by the Alexandria flag alone", () => {
    expect(getAlexandriaZDR({ alexandriaZDR: "forced" })).toBe("forced");
    expect(
      isAlexandriaZDRForced({ alexandriaZDR: "forced", scrapeZDR: "allowed" }),
    ).toBe(true);
  });

  it("is forced when scrape ZDR is forced, legacy flag included", () => {
    expect(isAlexandriaZDRForced({ scrapeZDR: "forced" })).toBe(true);
    expect(isAlexandriaZDRForced({ forceZDR: true })).toBe(true);
  });

  it("is not forced for allowed or unset flags", () => {
    expect(getAlexandriaZDR({ alexandriaZDR: "allowed" })).toBe("allowed");
    expect(getAlexandriaZDR({ scrapeZDR: "allowed" })).toBe("allowed");
    expect(isAlexandriaZDRForced({ alexandriaZDR: "allowed" })).toBe(false);
    expect(isAlexandriaZDRForced(undefined)).toBe(false);
    expect(getAlexandriaZDR({ alexandriaZDR: "disabled" })).toBe("disabled");
  });
});
