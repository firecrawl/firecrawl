import { getAgentZdrRetentionMinutes, isDpaRestricted } from "./zdr-helpers";

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
