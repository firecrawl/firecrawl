import { isSameDomain, removeDuplicateUrls } from "./validateUrl";
import { isSameSubdomain } from "./validateUrl";

describe("isSameDomain", () => {
  it("should return true for a subdomain", () => {
    const result = isSameDomain("http://sub.example.com", "http://example.com");
    expect(result).toBe(true);
  });

  it("should return true for the same domain", () => {
    const result = isSameDomain("http://example.com", "http://example.com");
    expect(result).toBe(true);
  });

  it("should return false for different domains", () => {
    const result = isSameDomain("http://example.com", "http://another.com");
    expect(result).toBe(false);
  });

  it("should treat different registrable domains under a multi-part suffix as different", () => {
    // co.uk / github.io are public suffixes, so foo.co.uk and bar.co.uk are
    // different sites. The last-two-labels split wrongly reported them equal.
    expect(isSameDomain("https://foo.co.uk", "https://bar.co.uk")).toBe(false);
    expect(isSameDomain("https://a.github.io", "https://b.github.io")).toBe(false);
    expect(isSameDomain("https://x.example.co.uk", "https://y.example.co.uk")).toBe(true);
  });

  it("should return true for a subdomain with different protocols", () => {
    const result = isSameDomain(
      "https://sub.example.com",
      "http://example.com",
    );
    expect(result).toBe(true);
  });

  it("should return false for invalid URLs", () => {
    const result = isSameDomain("invalid-url", "http://example.com");
    expect(result).toBe(false);
    const result2 = isSameDomain("http://example.com", "invalid-url");
    expect(result2).toBe(false);
  });

  it("should return true for a subdomain with www prefix", () => {
    const result = isSameDomain(
      "http://www.sub.example.com",
      "http://example.com",
    );
    expect(result).toBe(true);
  });

  it("should return true for the same domain with www prefix", () => {
    const result = isSameDomain(
      "http://docs.s.s.example.com",
      "http://example.com",
    );
    expect(result).toBe(true);
  });
});

describe("isSameSubdomain", () => {
  it("should return false for a subdomain", () => {
    const result = isSameSubdomain(
      "http://example.com",
      "http://docs.example.com",
    );
    expect(result).toBe(false);
  });

  it("should return true for the same subdomain", () => {
    const result = isSameSubdomain(
      "http://docs.example.com",
      "http://docs.example.com",
    );
    expect(result).toBe(true);
  });

  it("should return false for different subdomains", () => {
    const result = isSameSubdomain(
      "http://docs.example.com",
      "http://blog.example.com",
    );
    expect(result).toBe(false);
  });

  it("should return false for different domains", () => {
    const result = isSameSubdomain("http://example.com", "http://another.com");
    expect(result).toBe(false);
  });

  it("should compare subdomains under a multi-part suffix correctly", () => {
    // Registrable domain is example.co.uk and the subdomain is just "sub":
    // the last-two-labels split treated the domain as co.uk and the subdomain
    // as sub.example, so two different sites compared equal.
    expect(
      isSameSubdomain("https://sub.example.co.uk", "https://other.example.co.uk"),
    ).toBe(false);
    expect(
      isSameSubdomain("https://sub.example.co.uk", "https://sub.example.co.uk"),
    ).toBe(true);
  });

  it("should return false for invalid URLs", () => {
    const result = isSameSubdomain("invalid-url", "http://example.com");
    expect(result).toBe(false);
    const result2 = isSameSubdomain("http://example.com", "invalid-url");
    expect(result2).toBe(false);
  });

  it("should return true for the same subdomain with different protocols", () => {
    const result = isSameSubdomain(
      "https://docs.example.com",
      "http://docs.example.com",
    );
    expect(result).toBe(true);
  });

  it("should return true for the same subdomain with www prefix", () => {
    const result = isSameSubdomain(
      "http://www.docs.example.com",
      "http://docs.example.com",
    );
    expect(result).toBe(true);
  });

  it("should return false for a subdomain with www prefix and different subdomain", () => {
    const result = isSameSubdomain(
      "http://www.docs.example.com",
      "http://blog.example.com",
    );
    expect(result).toBe(false);
  });
});

describe("removeDuplicateUrls", () => {
  it("should remove duplicate URLs with different protocols", () => {
    const urls = [
      "http://example.com",
      "https://example.com",
      "http://www.example.com",
      "https://www.example.com",
    ];
    const result = removeDuplicateUrls(urls);
    expect(result).toEqual(["https://example.com"]);
  });

  it("should keep URLs with different paths", () => {
    const urls = [
      "https://example.com/page1",
      "https://example.com/page2",
      "https://example.com/page1?param=1",
      "https://example.com/page1#section1",
    ];
    const result = removeDuplicateUrls(urls);
    expect(result).toEqual([
      "https://example.com/page1",
      "https://example.com/page2",
      "https://example.com/page1?param=1",
      "https://example.com/page1#section1",
    ]);
  });

  it("should prefer https over http", () => {
    const urls = ["http://example.com", "https://example.com"];
    const result = removeDuplicateUrls(urls);
    expect(result).toEqual(["https://example.com"]);
  });

  it("should prefer non-www over www", () => {
    const urls = ["https://www.example.com", "https://example.com"];
    const result = removeDuplicateUrls(urls);
    expect(result).toEqual(["https://example.com"]);
  });

  it("should handle empty input", () => {
    const urls: string[] = [];
    const result = removeDuplicateUrls(urls);
    expect(result).toEqual([]);
  });

  it("should handle URLs with different cases", () => {
    const urls = ["https://EXAMPLE.com", "https://example.com"];
    const result = removeDuplicateUrls(urls);
    expect(result).toEqual(["https://EXAMPLE.com"]);
  });

  it("should handle URLs with trailing slashes", () => {
    const urls = ["https://example.com", "https://example.com/"];
    const result = removeDuplicateUrls(urls);
    expect(result).toEqual(["https://example.com"]);
  });
});
