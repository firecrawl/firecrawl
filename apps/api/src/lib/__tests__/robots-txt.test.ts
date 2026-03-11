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

  it("appends trailing slash to pathname only, preserving query and fragment", () => {
    const robots = {
      isAllowed: jest.fn((url: string, userAgent: string) => {
        if (userAgent !== "TestBot") return undefined;
        // deny the slash variant at the pathname level
        if (url === "https://example.com/page/?q=1") return false;
        return true;
      }),
    } as any;

    // Without the fix, url + "/" would produce "https://example.com/page?q=1/"
    // which wouldn't match the deny rule and would incorrectly return true
    expect(
      isUrlAllowedByRobotsForUserAgents(
        "https://example.com/page?q=1",
        robots,
        ["TestBot"],
      ),
    ).toBe(false);

    // Verify the mock was called with the correctly formed URL
    expect(robots.isAllowed).toHaveBeenCalledWith(
      "https://example.com/page/?q=1",
      "TestBot",
    );
  });
});
