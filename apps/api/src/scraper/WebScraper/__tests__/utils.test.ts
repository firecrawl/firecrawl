import { WebCrawler } from "../crawler";

describe("WebCrawler - section anchors", () => {
  let crawler: WebCrawler;

  beforeEach(() => {
    crawler = new WebCrawler({
      jobId: "test-job",
      initialUrl: "https://example.com",
      baseUrl: "https://example.com",
      includes: [],
      excludes: [],
    });
  });

  async function resolve(url: string): Promise<string | undefined> {
    const { allowed, url: resolved } = await crawler.filterURL(
      url,
      "https://example.com",
    );
    expect(allowed).toBe(true);
    return resolved;
  }

  describe("section links in filterURL", () => {
    it("should keep URLs without hash fragments unchanged", async () => {
      expect(await resolve("https://example.com/page")).toBe(
        "https://example.com/page",
      );
      expect(await resolve("https://example.com/blog/post")).toBe(
        "https://example.com/blog/post",
      );
    });

    it("should strip simple anchors and keep the page", async () => {
      expect(await resolve("https://example.com/page#section")).toBe(
        "https://example.com/page",
      );
      expect(await resolve("https://example.com/page#top")).toBe(
        "https://example.com/page",
      );
      expect(await resolve("https://example.com/page#")).toBe(
        "https://example.com/page",
      );
      expect(await resolve("https://example.com/page#a")).toBe(
        "https://example.com/page",
      );
    });

    it("should keep the query when stripping an anchor", async () => {
      expect(
        await resolve("https://example.com/hc/sections/1?page=2#articles"),
      ).toBe("https://example.com/hc/sections/1?page=2");
    });

    it("should keep hash fragments that look like routes", async () => {
      expect(await resolve("https://example.com/app#/dashboard")).toBe(
        "https://example.com/app#/dashboard",
      );
      expect(await resolve("https://example.com/spa#/user/profile")).toBe(
        "https://example.com/spa#/user/profile",
      );
      expect(await resolve("https://example.com/page#abc/def")).toBe(
        "https://example.com/page#abc/def",
      );
    });

    it("should strip short hash fragments even with slashes", async () => {
      expect(await resolve("https://example.com/page#/")).toBe(
        "https://example.com/page",
      );
      expect(await resolve("https://example.com/page#ab")).toBe(
        "https://example.com/page",
      );
    });
  });
});
