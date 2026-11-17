import { WebCrawler } from "../crawler";

describe("WebCrawler - noSections", () => {
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

  async function noSections(url: string): Promise<boolean> {
    const { allowed, denialReason } = await crawler.filterURL(
      url,
      "https://example.com",
    );
    expect(denialReason).toBe(allowed ? undefined : "SECTION_LINK");
    return allowed;
  }

  describe("section links in filterURL", () => {
    it("should return true for URLs without hash fragments", async () => {
      expect(await noSections("https://example.com/page")).toBe(true);
      expect(await noSections("https://example.com/blog/post")).toBe(true);
      expect(await noSections("https://example.com")).toBe(true);
    });

    it("should return false for simple anchor links", async () => {
      expect(await noSections("https://example.com/page#section")).toBe(false);
      expect(await noSections("https://example.com/page#top")).toBe(false);
      expect(await noSections("https://example.com/page#")).toBe(false);
      expect(await noSections("https://example.com/page#a")).toBe(false);
    });

    it("should return true for hash fragments that look like routes", async () => {
      expect(await noSections("https://example.com/app#/dashboard")).toBe(true);
      expect(await noSections("https://example.com/spa#/user/profile")).toBe(
        true,
      );
      expect(
        await noSections("https://example.com/page#/settings/account"),
      ).toBe(true);
    });

    it("should return false for short hash fragments even with slashes", async () => {
      expect(await noSections("https://example.com/page#/")).toBe(false);
    });

    it("should handle edge cases", async () => {
      expect(await noSections("https://example.com/page#ab")).toBe(false);
      expect(await noSections("https://example.com/page#abc/def")).toBe(true);
    });
  });
});
