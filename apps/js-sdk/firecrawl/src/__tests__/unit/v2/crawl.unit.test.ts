import { describe, test, expect, jest } from "@jest/globals";
import { startCrawl } from "../../../v2/methods/crawl";

describe("JS SDK v2 startCrawl payload", () => {
  test("forwards ignoreRobotsTxt to the crawl request body", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, id: "crawl-123", url: "https://example.com/crawl/crawl-123" },
    }));

    const http = { post } as any;
    await startCrawl(http, { url: "https://example.com", ignoreRobotsTxt: true });

    expect(post).toHaveBeenCalledWith(
      "/v2/crawl",
      expect.objectContaining({ ignoreRobotsTxt: true }),
    );
  });

  test("omits ignoreRobotsTxt from the crawl request body when not provided", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, id: "crawl-123", url: "https://example.com/crawl/crawl-123" },
    }));

    const http = { post } as any;
    await startCrawl(http, { url: "https://example.com" });

    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty("ignoreRobotsTxt");
  });

  test("forwards ignoreRobotsTxt alongside robotsUserAgent", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, id: "crawl-456", url: "https://example.com/crawl/crawl-456" },
    }));

    const http = { post } as any;
    await startCrawl(http, {
      url: "https://example.com",
      ignoreRobotsTxt: true,
      robotsUserAgent: "CustomBot/1.0",
    });

    expect(post).toHaveBeenCalledWith(
      "/v2/crawl",
      expect.objectContaining({
        ignoreRobotsTxt: true,
        robotsUserAgent: "CustomBot/1.0",
      }),
    );
  });
});
