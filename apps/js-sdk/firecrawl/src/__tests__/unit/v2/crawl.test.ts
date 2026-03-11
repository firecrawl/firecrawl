import { describe, expect, test, jest } from "@jest/globals";
import { startCrawl } from "../../../v2/methods/crawl";

describe("v2.crawl payload", () => {
  function makeHttp(postImpl: (url: string, data: any) => any) {
    return { post: jest.fn(async (u: string, d: any) => postImpl(u, d)) } as any;
  }

  test("serializes ignoreRobotsTxt and robotsMode in crawl payload", async () => {
    const http = makeHttp((_url, data) => ({
      status: 200,
      data: {
        success: true,
        id: "crawl_123",
        url: data.url,
      },
    }));

    await startCrawl(http, {
      url: "https://example.com",
      ignoreRobotsTxt: false,
      robotsMode: "strict",
    });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/crawl",
      expect.objectContaining({
        url: "https://example.com",
        ignoreRobotsTxt: false,
        robotsMode: "strict",
      }),
    );
  });
});
