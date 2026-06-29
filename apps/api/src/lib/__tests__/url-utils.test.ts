import {
  isBaseDomain,
  extractBaseDomain,
  stripUrlUserInfo,
} from "../url-utils";

describe("URL Utils", () => {
  describe("isBaseDomain", () => {
    it("should return true for base domains", () => {
      expect(isBaseDomain("https://example.com")).toBe(true);
      expect(isBaseDomain("https://www.example.com")).toBe(true);
      expect(isBaseDomain("https://example.co.uk")).toBe(true);
      expect(isBaseDomain("https://www.example.co.uk")).toBe(true);
      expect(isBaseDomain("http://example.com")).toBe(true);
      expect(isBaseDomain("https://example.com/")).toBe(true);
    });

    it("should return false for subdomains", () => {
      expect(isBaseDomain("https://blog.example.com")).toBe(false);
      expect(isBaseDomain("https://api.example.com")).toBe(false);
      expect(isBaseDomain("https://www.blog.example.com")).toBe(false);
    });

    it("should return false for URLs with paths", () => {
      expect(isBaseDomain("https://example.com/path")).toBe(false);
      expect(isBaseDomain("https://example.com/path/to/page")).toBe(false);
      expect(isBaseDomain("https://example.com/path?query=1")).toBe(false);
    });

    it("should return false for invalid URLs", () => {
      expect(isBaseDomain("not-a-url")).toBe(false);
      expect(isBaseDomain("")).toBe(false);
    });
  });

  describe("extractBaseDomain", () => {
    it("should extract base domain correctly", () => {
      expect(extractBaseDomain("https://example.com")).toBe("example.com");
      expect(extractBaseDomain("https://www.example.com")).toBe("example.com");
      expect(extractBaseDomain("https://blog.example.com")).toBe("example.com");
      expect(extractBaseDomain("https://api.example.com")).toBe("example.com");
      expect(extractBaseDomain("https://example.com/path")).toBe("example.com");
    });

    it("should handle complex domains", () => {
      expect(extractBaseDomain("https://subdomain.example.co.uk")).toBe(
        "example.co.uk",
      );
      expect(extractBaseDomain("https://www.example.co.uk")).toBe(
        "example.co.uk",
      );
      expect(extractBaseDomain("https://subdomain.example.com")).toBe(
        "example.com",
      );
      expect(extractBaseDomain("https://www.example.com")).toBe("example.com");
    });

    it("should return null for invalid URLs", () => {
      expect(extractBaseDomain("not-a-url")).toBe(null);
      expect(extractBaseDomain("")).toBe(null);
    });
  });

  describe("stripUrlUserInfo", () => {
    it("strips username from basic auth URLs", () => {
      expect(stripUrlUserInfo("https://user@example.com/page")).toBe(
        "https://example.com/page",
      );
      expect(stripUrlUserInfo("http://user@example.com/")).toBe(
        "http://example.com/",
      );
    });

    it("strips username:password from basic auth URLs", () => {
      expect(stripUrlUserInfo("https://user:pass@example.com/page")).toBe(
        "https://example.com/page",
      );
      expect(stripUrlUserInfo("http://admin:secret@example.com/path")).toBe(
        "http://example.com/path",
      );
    });

    it("normalizes malformed mailto-style URLs (https://email@domain.com)", () => {
      expect(stripUrlUserInfo("https://contact@example.com")).toBe(
        "https://example.com/",
      );
      expect(stripUrlUserInfo("https://support@company.co.uk/page")).toBe(
        "https://company.co.uk/page",
      );
    });

    it("leaves URLs without userinfo unchanged", () => {
      expect(stripUrlUserInfo("https://example.com/page")).toBe(
        "https://example.com/page",
      );
      expect(stripUrlUserInfo("http://example.org/path?q=1")).toBe(
        "http://example.org/path?q=1",
      );
    });

    it("handles URLs with path, query, and fragment", () => {
      expect(
        stripUrlUserInfo("https://user:pass@example.com/path?q=1#anchor"),
      ).toBe("https://example.com/path?q=1#anchor");
    });

    it("leaves non-http(s) protocols unchanged", () => {
      expect(stripUrlUserInfo("mailto:user@example.com")).toBe(
        "mailto:user@example.com",
      );
      expect(stripUrlUserInfo("ftp://user:pass@ftp.example.com/")).toBe(
        "ftp://user:pass@ftp.example.com/",
      );
    });

    it("returns original string for invalid URLs", () => {
      expect(stripUrlUserInfo("not-a-valid-url")).toBe("not-a-valid-url");
      expect(stripUrlUserInfo("")).toBe("");
    });

    it("handles punycode and internationalized domains", () => {
      expect(
        stripUrlUserInfo("https://user@xn--example-9ua.com/page"),
      ).toBe("https://xn--example-9ua.com/page");
    });

    it("handles port numbers in URLs with userinfo", () => {
      expect(stripUrlUserInfo("https://user@example.com:8080/path")).toBe(
        "https://example.com:8080/path",
      );
    });

    it("handles userinfo with special characters", () => {
      const encoded = "https://user%40mail.com:pass%23@example.com/page";
      expect(stripUrlUserInfo(encoded)).toBe("https://example.com/page");
    });
  });
});
