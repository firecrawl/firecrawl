import { isBaseDomain, extractBaseDomain } from "../url-utils";

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
});
