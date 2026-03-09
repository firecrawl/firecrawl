import { shouldDenyCrawlTarget } from "../crawl-target-policy";

describe("shouldDenyCrawlTarget", () => {
  it("denies external links when external crawling is disabled", () => {
    expect(
      shouldDenyCrawlTarget({
        initialUrl: "https://example.com/docs",
        targetUrl: "https://other.com/docs",
        allowExternalContentLinks: false,
        allowSubdomains: false,
      }),
    ).toBe("EXTERNAL_LINK");
  });

  it("denies subdomains when allowSubdomains is false", () => {
    expect(
      shouldDenyCrawlTarget({
        initialUrl: "https://example.com/docs",
        targetUrl: "https://blog.example.com/docs/post",
        allowExternalContentLinks: false,
        allowSubdomains: false,
      }),
    ).toBe("EXTERNAL_LINK");
  });

  it("allows same registrable domain subdomains when allowSubdomains is true", () => {
    expect(
      shouldDenyCrawlTarget({
        initialUrl: "https://example.co.uk/docs",
        targetUrl: "https://blog.example.co.uk/docs/post",
        allowExternalContentLinks: false,
        allowSubdomains: true,
      }),
    ).toBeNull();
  });

  it("allows external links when allowExternalContentLinks is true", () => {
    expect(
      shouldDenyCrawlTarget({
        initialUrl: "https://example.com/docs",
        targetUrl: "https://other.com/docs",
        allowExternalContentLinks: true,
        allowSubdomains: false,
      }),
    ).toBeNull();
  });
});
