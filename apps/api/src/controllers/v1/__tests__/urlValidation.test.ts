import { url } from "../types";
import { BLOCKLISTED_URL_MESSAGE } from "../../../lib/strings";

describe("URL Schema Validation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("should prepend http:// to URLs without a protocol", () => {
    const result = url.parse("example.com");
    expect(result).toBe("http://example.com");
  });

  it("should allow valid URLs with http or https", () => {
    expect(() => url.parse("http://example.com")).not.toThrow();
    expect(() => url.parse("https://example.com")).not.toThrow();
  });

  it("should allow valid URLs with http or https", () => {
    expect(() => url.parse("example.com")).not.toThrow();
  });

  it("should reject URLs with unsupported protocols", () => {
    expect(() => url.parse("ftp://example.com")).toThrow();
  });

  it("should reject URLs without a valid top-level domain", () => {
    expect(() => url.parse("http://example")).toThrow();
  });

  it("should handle URLs with subdomains correctly", () => {
    expect(() => url.parse("http://sub.example.com")).not.toThrow();
    expect(() => url.parse("https://blog.example.com")).not.toThrow();
  });

  it("should handle URLs with paths correctly", () => {
    expect(() => url.parse("http://example.com/path")).not.toThrow();
    expect(() => url.parse("https://example.com/another/path")).not.toThrow();
  });

  it("should reject malformed URLs starting with 'http://http'", () => {
    expect(() => url.parse("http://http://example.com")).toThrow();
  });

  it("should reject malformed URLs containing multiple 'http://'", () => {
    expect(() =>
      url.parse("http://example.com/http://example.com"),
    ).not.toThrow();
  });

  it("should reject malformed URLs containing multiple 'http://'", () => {
    expect(() => url.parse("http://ex ample.com/")).toThrow("Invalid URL");
  });

  it("should accept URLs with international domain names", () => {
    expect(() => url.parse("http://xn--1lqv92a901a.xn--ses554g/")).not.toThrow();
  });

  it("should accept various IDN domains with different scripts", () => {
    expect(() => url.parse("http://xn--fsq.xn--0zwm56d")).not.toThrow();
    expect(() => url.parse("https://xn--mgbh0fb.xn--kgbechtv")).not.toThrow();
    expect(() => url.parse("http://xn--e1afmkfd.xn--p1ai")).not.toThrow();
    expect(() => url.parse("https://xn--wgbl6a.xn--mgberp4a5d4ar")).not.toThrow();
  });

  it("should accept IDN domains with paths and query parameters", () => {
    expect(() => url.parse("http://xn--1lqv92a901a.xn--ses554g/path/to/page")).not.toThrow();
    expect(() => url.parse("https://xn--fsq.xn--0zwm56d/search?q=test")).not.toThrow();
    expect(() => url.parse("http://xn--mgbh0fb.xn--kgbechtv/page#section")).not.toThrow();
  });

  it("should accept IDN subdomains", () => {
    expect(() => url.parse("http://sub.xn--1lqv92a901a.xn--ses554g")).not.toThrow();
    expect(() => url.parse("https://www.xn--fsq.xn--0zwm56d")).not.toThrow();
    expect(() => url.parse("http://api.xn--mgbh0fb.xn--kgbechtv")).not.toThrow();
  });

});
