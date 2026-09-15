import { isDpaRestricted } from "./zdr-helpers";

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
