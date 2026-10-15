import { WebCrawler } from "../crawler";

vi.mock("axios");
vi.mock("robots-parser", () => ({
  default: () => ({
    isAllowed: () => true,
    isDisallowed: () => false,
    getMatchingLineNumber: () => 0,
    getCrawlDelay: () => 0,
    getSitemaps: () => [],
    getPreferredHost: () => "example.com",
  }),
}));

// Force the JS fallback in WebCrawler.filterLinks by making the native
// filter throw, the same failure the fallback exists for.
vi.mock("@mendable/firecrawl-rs", () => {
  const stub = () => undefined;
  return {
    convertDocumentToMarkdown: stub,
    detectPdf: stub,
    extractAttributes: stub,
    extractImages: stub,
    extractLinks: stub,
    extractMetadata: stub,
    filterLinks: () => {
      throw new Error("native filter unavailable");
    },
    filterUrl: stub,
    firecrawl: stub,
    getInnerJson: stub,
    postProcessMarkdown: stub,
    processPdf: stub,
    transformHtml: stub,
    validateRegexes: stub,
  };
});

describe("WebCrawler.filterLinks JS fallback host scoping", () => {
  const makeCrawler = (options: object = {}) =>
    new WebCrawler({
      jobId: "TEST",
      initialUrl: "https://example.com",
      includes: [],
      excludes: [],
      maxCrawledDepth: 10,
      ...options,
    });

  it("keeps same-host links", async () => {
    const crawler = makeCrawler();
    const { links } = await crawler.filterLinks(
      ["https://example.com/docs/page"],
      100,
      10,
    );
    expect(links).toContain("https://example.com/docs/page");
  });

  it("denies external hosts when allowExternalContentLinks is false", async () => {
    const crawler = makeCrawler();
    const { links, denialReasons } = await crawler.filterLinks(
      ["https://other.com/page"],
      100,
      10,
    );
    expect(links).not.toContain("https://other.com/page");
    expect(denialReasons.has("https://other.com/page")).toBe(true);
  });

  it("allows external hosts when allowExternalContentLinks is true", async () => {
    const crawler = makeCrawler({ allowExternalContentLinks: true });
    const { links } = await crawler.filterLinks(
      ["https://other.com/page"],
      100,
      10,
    );
    expect(links).toContain("https://other.com/page");
  });

  it("denies subdomains when allowSubdomains is false", async () => {
    const crawler = makeCrawler();
    const { links, denialReasons } = await crawler.filterLinks(
      ["https://blog.example.com/page"],
      100,
      10,
    );
    expect(links).not.toContain("https://blog.example.com/page");
    expect(denialReasons.has("https://blog.example.com/page")).toBe(true);
  });

  it("allows subdomains when allowSubdomains is true", async () => {
    const crawler = makeCrawler({ allowSubdomains: true });
    const { links } = await crawler.filterLinks(
      ["https://blog.example.com/page"],
      100,
      10,
    );
    expect(links).toContain("https://blog.example.com/page");
  });

  it("treats www and non-www forms of the initial host as the same host", async () => {
    const crawler = makeCrawler({ initialUrl: "https://www.example.com" });
    const { links } = await crawler.filterLinks(
      ["https://example.com/page"],
      100,
      10,
    );
    expect(links).toContain("https://example.com/page");
  });

  it("recognizes a file extension before a fragment in isFile", () => {
    const crawler = makeCrawler();
    expect(crawler.isFile("https://example.com/download.zip#section")).toBe(
      true,
    );
    expect(crawler.isFile("https://example.com/page#section")).toBe(false);
  });

  it("denies an external homepage even when allowExternalContentLinks is true", async () => {
    const crawler = makeCrawler({ allowExternalContentLinks: true });
    const { links, denialReasons } = await crawler.filterLinks(
      ["https://other.com/", "https://other.com/article"],
      100,
      10,
    );
    expect(links).not.toContain("https://other.com/");
    expect(denialReasons.has("https://other.com/")).toBe(true);
    expect(links).toContain("https://other.com/article");
  });

  it("classifies sibling subdomains and the apex by registrable domain", async () => {
    const crawler = makeCrawler({ initialUrl: "https://docs.example.com" });
    const denied = await crawler.filterLinks(
      ["https://blog.example.com/page", "https://example.com/page"],
      100,
      10,
    );
    expect(denied.links).not.toContain("https://blog.example.com/page");
    expect(denied.links).not.toContain("https://example.com/page");

    const allowed = await makeCrawler({
      initialUrl: "https://docs.example.com",
      allowSubdomains: true,
    }).filterLinks(
      ["https://blog.example.com/page", "https://example.com/page"],
      100,
      10,
    );
    expect(allowed.links).toContain("https://blog.example.com/page");
    expect(allowed.links).toContain("https://example.com/page");
  });

  it("does not apply the initial path scope to admitted off-host links", async () => {
    const external = await makeCrawler({
      initialUrl: "https://example.com/docs/guide",
      allowExternalContentLinks: true,
    }).filterLinks(["https://other.com/elsewhere/deep"], 100, 10);
    expect(external.links).toContain("https://other.com/elsewhere/deep");

    const subdomain = await makeCrawler({
      initialUrl: "https://example.com/docs/guide",
      allowSubdomains: true,
    }).filterLinks(["https://blog.example.com/elsewhere"], 100, 10);
    expect(subdomain.links).toContain("https://blog.example.com/elsewhere");

    const sameHost = await makeCrawler({
      initialUrl: "https://example.com/docs/guide",
    }).filterLinks(["https://example.com/other"], 100, 10);
    expect(sameHost.links).not.toContain("https://example.com/other");
  });

  it("reports the bare extension for a file link carrying a fragment", async () => {
    const crawler = makeCrawler();
    const { links, denialReasons } = await crawler.filterLinks(
      ["https://example.com/download.zip#section"],
      100,
      10,
    );
    expect(links).not.toContain("https://example.com/download.zip#section");
    const reason = denialReasons.get(
      "https://example.com/download.zip#section",
    );
    expect(reason).toContain('extension ".zip"');
    expect(reason).not.toContain("#section");
  });
});
