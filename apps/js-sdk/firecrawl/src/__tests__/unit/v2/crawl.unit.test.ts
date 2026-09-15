import { describe, expect, jest, test } from "@jest/globals";
import { startCrawl } from "../../../v2/methods/crawl";

describe("v2 crawl payload", () => {
  test("forwards ignoreRobotsTxt when set", async () => {
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: { success: true, id: "crawl-1", url: "https://api.example/v2/crawl/crawl-1" },
      })),
    } as any;

    await startCrawl(http, {
      url: "https://example.com",
      ignoreRobotsTxt: true,
    });

    expect(http.post).toHaveBeenCalledWith("/v2/crawl", {
      url: "https://example.com",
      ignoreRobotsTxt: true,
    });
  });

  test("forwards robotsUserAgent alongside ignoreRobotsTxt", async () => {
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: { success: true, id: "crawl-2", url: "https://api.example/v2/crawl/crawl-2" },
      })),
    } as any;

    await startCrawl(http, {
      url: "https://example.com",
      ignoreRobotsTxt: false,
      robotsUserAgent: "MyBot/1.0",
    });

    expect(http.post).toHaveBeenCalledWith("/v2/crawl", {
      url: "https://example.com",
      ignoreRobotsTxt: false,
      robotsUserAgent: "MyBot/1.0",
    });
  });

  test("omits ignoreRobotsTxt when undefined", async () => {
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: { success: true, id: "crawl-3", url: "https://api.example/v2/crawl/crawl-3" },
      })),
    } as any;

    await startCrawl(http, { url: "https://example.com" });

    const payload = http.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toEqual({ url: "https://example.com" });
    expect(payload).not.toHaveProperty("ignoreRobotsTxt");
  });
});
