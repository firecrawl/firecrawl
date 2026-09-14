/**
 * Unit tests for v2 crawl payload serialisation.
 *
 * Regression tests for:
 *   https://github.com/firecrawl/firecrawl/issues/3940
 *   JS SDK v2 crawl() silently drops ignoreRobotsTxt option
 */
import { describe, expect, test, jest } from "@jest/globals";
import { startCrawl } from "../../../v2/methods/crawl";

describe("v2.crawl unit - prepareCrawlPayload", () => {
  function makeHttp() {
    return {
      post: jest.fn().mockResolvedValue({
        status: 200,
        data: { success: true, id: "crawl-123", url: "https://api.firecrawl.dev/v2/crawl/crawl-123" },
      }),
    } as any;
  }

  test("forwards ignoreRobotsTxt: true to the API", async () => {
    const http = makeHttp();
    await startCrawl(http, { url: "https://example.com", ignoreRobotsTxt: true });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/crawl",
      expect.objectContaining({ ignoreRobotsTxt: true }),
    );
  });

  test("forwards ignoreRobotsTxt: false to the API", async () => {
    const http = makeHttp();
    await startCrawl(http, { url: "https://example.com", ignoreRobotsTxt: false });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/crawl",
      expect.objectContaining({ ignoreRobotsTxt: false }),
    );
  });

  test("omits ignoreRobotsTxt when not set", async () => {
    const http = makeHttp();
    await startCrawl(http, { url: "https://example.com" });
    const payload = http.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("ignoreRobotsTxt");
  });

  test("forwards all standard options in a single call", async () => {
    const http = makeHttp();
    await startCrawl(http, {
      url: "https://example.com",
      ignoreRobotsTxt: true,
      limit: 50,
      allowExternalLinks: false,
      allowSubdomains: true,
      maxConcurrency: 5,
      delay: 2,
    });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/crawl",
      expect.objectContaining({
        url: "https://example.com",
        ignoreRobotsTxt: true,
        limit: 50,
        allowExternalLinks: false,
        allowSubdomains: true,
        maxConcurrency: 5,
        delay: 2,
      }),
    );
  });
});
