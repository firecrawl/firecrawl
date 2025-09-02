import { generateDomainSplits } from "../../services/index";

describe("generateDomainSplits", () => {
  it("should return original domain splits when no fake domain provided", () => {
    const result = generateDomainSplits("example.com");
    expect(result).toEqual(["example.com"]);
  });

  it("should return fake domain when provided without subdomains", () => {
    const result = generateDomainSplits("example.com", "fake.com");
    expect(result).toEqual(["fake.com"]);
  });

  it("should apply same splitting logic to fake domain with subdomains", () => {
    const result = generateDomainSplits("sub.example.com", "api.fake.com");
    expect(result).toEqual(["fake.com", "api.fake.com"]);
  });

  it("should apply splitting logic to fake domain with multiple subdomains", () => {
    const result = generateDomainSplits("a.b.example.com", "x.y.fake.org");
    expect(result).toEqual(["fake.org", "y.fake.org", "x.y.fake.org"]);
  });

  it("should handle www subdomain in fake domain correctly", () => {
    const result = generateDomainSplits("www.example.com", "www.fake.com");
    expect(result).toEqual(["fake.com"]);
  });

  it("should return fake domain when original hostname is invalid", () => {
    const result = generateDomainSplits("invalid", "fake.com");
    expect(result).toEqual(["fake.com"]);
  });

  it("should return fake domain when fake domain is invalid", () => {
    const result = generateDomainSplits("example.com", "invalid");
    expect(result).toEqual(["invalid"]);
  });

  it("should handle complex subdomain structures with fake domain", () => {
    const result = generateDomainSplits(
      "api.v1.service.example.com",
      "sub.test.org",
    );
    expect(result).toEqual(["test.org", "sub.test.org"]);
  });
});
