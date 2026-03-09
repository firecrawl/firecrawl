import { isUrlAllowedByRobotsForUserAgents } from "../robots-access";

describe("isUrlAllowedByRobotsForUserAgents", () => {
  it("treats an explicit denial for the exact user agent as authoritative", () => {
    const robots = {
      isAllowed: jest.fn((url: string, userAgent: string) => {
        if (userAgent === "MyBot/1.0") return false;
        if (userAgent === "MyBot") return true;
        return undefined;
      }),
    } as any;

    expect(
      isUrlAllowedByRobotsForUserAgents(
        "https://example.com/blocked",
        robots,
        ["MyBot/1.0", "MyBot"],
      ),
    ).toBe(false);
  });

  it("falls back to the derived user agent only when the exact one has no explicit match", () => {
    const robots = {
      isAllowed: jest.fn((url: string, userAgent: string) => {
        if (userAgent === "MyBot/1.0") return undefined;
        if (userAgent === "MyBot") return true;
        return undefined;
      }),
    } as any;

    expect(
      isUrlAllowedByRobotsForUserAgents(
        "https://example.com/allowed",
        robots,
        ["MyBot/1.0", "MyBot"],
      ),
    ).toBe(true);
  });

  it("preserves trailing-slash denial checks for explicit matches", () => {
    const robots = {
      isAllowed: jest.fn((url: string, userAgent: string) => {
        if (userAgent !== "MyBot/1.0") return undefined;
        if (url.endsWith("/")) return false;
        return true;
      }),
    } as any;

    expect(
      isUrlAllowedByRobotsForUserAgents(
        "https://example.com/path",
        robots,
        ["MyBot/1.0"],
      ),
    ).toBe(false);
  });
});
