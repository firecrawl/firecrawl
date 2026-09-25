import { describe, test, expect, jest } from "@jest/globals";
import { startCrawl } from "../../../v2/methods/crawl";

function makeHttp(data: Record<string, unknown>) {
  const post = jest.fn(async () => ({ status: 200, data }));
  return {
    post,
    prepareHeaders: jest.fn(() => undefined),
  } as any;
}

describe("v2 crawl payload", () => {
  test("forwards ignoreRobotsTxt on startCrawl", async () => {
    const http = makeHttp({ success: true, id: "job", url: "u" });
    await startCrawl(http, {
      url: "https://example.com",
      ignoreRobotsTxt: true,
      robotsUserAgent: "docs-bot",
    });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/crawl",
      expect.objectContaining({
        url: "https://example.com",
        ignoreRobotsTxt: true,
        robotsUserAgent: "docs-bot",
      }),
    );
  });
});
