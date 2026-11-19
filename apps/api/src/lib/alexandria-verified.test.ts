import {
  alexandriaVerifiedHeader,
  isAlexandriaVerified,
} from "./alexandria-verified";

describe("alexandria verified", () => {
  it("is on only for exactly true", () => {
    expect(isAlexandriaVerified({ alexandriaVerified: true })).toBe(true);
    expect(isAlexandriaVerified({ alexandriaVerified: false })).toBe(false);
    expect(isAlexandriaVerified({})).toBe(false);
    expect(isAlexandriaVerified(null)).toBe(false);
    expect(isAlexandriaVerified(undefined)).toBe(false);
    expect(isAlexandriaVerified({ alexandriaVerified: "true" } as never)).toBe(
      false,
    );
  });

  it("builds the Exchange header only for a Verified team", () => {
    expect(alexandriaVerifiedHeader({ alexandriaVerified: true })).toEqual({
      "x-exchange-alexandria-verified": "true",
    });
    expect(alexandriaVerifiedHeader({})).toEqual({});
  });
});
