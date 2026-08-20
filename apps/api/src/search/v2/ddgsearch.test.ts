import { describe, expect, it, vi } from "vitest";
import { cleanUrl } from "./ddgsearch";

// silence logger.warn during tests
vi.mock("../../lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("cleanUrl", () => {
  it("decodes a valid uddg value with percent escapes", () => {
    const href =
      "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fq%3Dhello%20world";
    expect(cleanUrl(href)).toBe("https://example.com/path?q=hello world");
  });

  it("returns href unchanged when uddg is absent", () => {
    const href = "https://example.com/some/page";
    expect(cleanUrl(href)).toBe(href);
  });

  it("returns href unchanged when uddg is present but empty", () => {
    const href = "https://duckduckgo.com/l/?uddg=&other=1";
    expect(cleanUrl(href)).toBe(href);
  });

  it("returns href unchanged when uddg has a malformed percent escape (regression for #4375)", () => {
    // %ZZ is not a valid percent escape — decodeURIComponent throws URIError.
    const href =
      "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%ZZbad&ia=web";
    expect(() => cleanUrl(href)).not.toThrow();
    expect(cleanUrl(href)).toBe(href);
  });
});
