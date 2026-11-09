import {
  isBaseDomain,
  extractBaseDomain,
  hasReachableHost,
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

  describe("extractBaseDomain with multi-part suffixes", () => {
    it("uses the public suffix list, not the last two labels", () => {
      // slice(-2) produced "co.il" here, which cannot resolve
      expect(extractBaseDomain("https://crm.danetcomm.co.il/x")).toBe(
        "danetcomm.co.il",
      );
      expect(extractBaseDomain("https://jobs.example.co.uk")).toBe(
        "example.co.uk",
      );
      expect(extractBaseDomain("https://shop.example.com.au")).toBe(
        "example.com.au",
      );
    });

    it("treats hosting suffixes as public, so the host is its own base domain", () => {
      // requires allowPrivateDomains; otherwise this returns "vercel.app"
      expect(extractBaseDomain("https://hello.vercel.app")).toBe(
        "hello.vercel.app",
      );
      expect(extractBaseDomain("https://user.github.io")).toBe("user.github.io");
    });
  });

  describe("hasReachableHost", () => {
    it("accepts IP literals, which the old regex allowed only sometimes", () => {
      expect(hasReachableHost("https://8.8.8.8/")).toBe(true);
      expect(hasReachableHost("https://93.184.216.34/")).toBe(true);
      expect(hasReachableHost("http://[::1]/")).toBe(true);
      expect(hasReachableHost("https://1.1.1.10:8080/p")).toBe(true);
    });

    it("accepts real, private, punycode and special-use suffixes", () => {
      expect(hasReachableHost("https://example.com/")).toBe(true);
      expect(hasReachableHost("https://example.co.uk/")).toBe(true);
      expect(hasReachableHost("https://hello.vercel.app/")).toBe(true);
      expect(hasReachableHost("https://www.xn--fsq.xn--0zwm56d")).toBe(true);
      expect(hasReachableHost("https://foo.local/")).toBe(true);
      expect(hasReachableHost("https://foo.internal/")).toBe(true);
      expect(hasReachableHost("https://foo.lan/")).toBe(true);
    });

    it("rejects hosts with no TLD at all", () => {
      expect(hasReachableHost("https://example/")).toBe(false);
      expect(hasReachableHost("https://foo.c/")).toBe(false);
    });
  });
});

describe("parent-sitemap host filter", () => {
  // Mirrors the filter in crawler.ts tryFetchSitemapLinks: when a subdomain crawl
  // pulls the parent domain's sitemap, only the crawled host and its own children
  // may be kept. A bare endsWith would also admit sibling hosts sharing a suffix
  // of the final label.
  const keeps = (host: string, linkHost: string) =>
    linkHost === host || linkHost.endsWith(`.${host}`);

  const host = "crm.danetcomm.co.il";

  it("keeps the host itself and real child subdomains", () => {
    expect(keeps(host, "crm.danetcomm.co.il")).toBe(true);
    expect(keeps(host, "a.crm.danetcomm.co.il")).toBe(true);
  });

  it("rejects sibling hosts that merely end with the same string", () => {
    expect(keeps(host, "evilcrm.danetcomm.co.il")).toBe(false);
    expect(keeps(host, "xcrm.danetcomm.co.il")).toBe(false);
    expect(keeps(host, "other.danetcomm.co.il")).toBe(false);
  });
});
