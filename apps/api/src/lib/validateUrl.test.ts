import {
  isSameDomain,
  removeDuplicateUrls,
  removeWwwFromUrl,
} from "./validateUrl";
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

describe("removeWwwFromUrl", () => {
  it("should strip leading www. from standard https URLs", () => {
    expect(removeWwwFromUrl("https://www.example.com")).toBe(
      "https://example.com",
    );
    expect(removeWwwFromUrl("https://www.example.com/page")).toBe(
      "https://example.com/page",
    );
  });

  it("should strip leading www. from http URLs with custom ports", () => {
    expect(removeWwwFromUrl("http://www.example.com:8080/path")).toBe(
      "http://example.com:8080/path",
    );
  });

  it("should preserve www. in paths and query strings when the host has no www.", () => {
    expect(removeWwwFromUrl("https://example.com/www.tutorials/page")).toBe(
      "https://example.com/www.tutorials/page",
    );
    expect(
      removeWwwFromUrl("https://example.com/redirect?url=www.partner.com"),
    ).toBe("https://example.com/redirect?url=www.partner.com");
  });

  it("should not corrupt hostnames that merely contain www as a substring", () => {
    expect(removeWwwFromUrl("https://mywww.example.com")).toBe(
      "https://mywww.example.com",
    );
    expect(removeWwwFromUrl("https://mywww.com/page")).toBe(
      "https://mywww.com/page",
    );
  });

  it("should only strip the leading www. from the hostname and preserve later occurrences in the path", () => {
    expect(removeWwwFromUrl("https://www.example.com/www.example.com")).toBe(
      "https://example.com/www.example.com",
    );
  });

  it("should strip www. from bare domains without protocol", () => {
    expect(removeWwwFromUrl("www.example.com")).toBe("example.com");
    expect(removeWwwFromUrl("www.example.com/sub/page")).toBe(
      "example.com/sub/page",
    );
    expect(removeWwwFromUrl("www.example.com:8080/path")).toBe(
      "example.com:8080/path",
    );
  });

  it("should handle case-insensitive WWW.", () => {
    expect(removeWwwFromUrl("http://WWW.Example.com")).toBe(
      "http://Example.com",
    );
  });

  it("should preserve credentials in URLs while stripping leading www.", () => {
    expect(removeWwwFromUrl("https://user:pass@www.example.com/test")).toBe(
      "https://user:pass@example.com/test",
    );
    expect(removeWwwFromUrl("https://user@www.example.com")).toBe(
      "https://user@example.com",
    );
    expect(removeWwwFromUrl("https://user:@www.example.com")).toBe(
      "https://user:@example.com",
    );
    expect(removeWwwFromUrl("https://a@www.b@www.example.com")).toBe(
      "https://a@www.b@example.com",
    );
  });

  it("should not strip www. from username credentials", () => {
    expect(removeWwwFromUrl("https://www.user@example.com")).toBe(
      "https://www.user@example.com",
    );
    expect(removeWwwFromUrl("https://www.user:pass@example.com")).toBe(
      "https://www.user:pass@example.com",
    );
  });

  it("should not misinterpret @ characters in query strings as credentials", () => {
    expect(
      removeWwwFromUrl("https://www.example.com?email=user@www.example.com"),
    ).toBe("https://example.com?email=user@www.example.com");
  });
});
