import { describe, test, expect, jest } from "@jest/globals";
import { startCrawl } from "../../../v2/methods/crawl";

describe("JS SDK v2 crawl payload", () => {
  test("startCrawl forwards ignoreRobotsTxt to the request payload", async () => {
    const post = jest.fn(
      async (_url: string, _payload: Record<string, unknown>, _opts?: unknown) => ({
        status: 200,
        data: { success: true, id: "job-123", url: "https://api.firecrawl.dev/v2/crawl/job-123" },
      }),
    );

    const http = { post } as any;
    await startCrawl(http, {
      url: "https://example.com",
      ignoreRobotsTxt: true,
    });

    expect(post).toHaveBeenCalledWith(
      "/v2/crawl",
      expect.objectContaining({
        url: "https://example.com",
        ignoreRobotsTxt: true,
      }),
    );
  });

  test("startCrawl omits ignoreRobotsTxt when not provided", async () => {
    const post = jest.fn(
      async (_url: string, _payload: Record<string, unknown>, _opts?: unknown) => ({
        status: 200,
        data: { success: true, id: "job-456", url: "https://api.firecrawl.dev/v2/crawl/job-456" },
      }),
    );

    const http = { post } as any;
    await startCrawl(http, { url: "https://example.com" });

    const [, payload] = post.mock.calls[0];
    expect(payload).not.toHaveProperty("ignoreRobotsTxt");
  });
});