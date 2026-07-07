import { describe, expect, jest, test } from "@jest/globals";
import { startCrawl } from "../../../v2/methods/crawl";

describe("v2.crawl unit", () => {
  test("startCrawl forwards ignoreRobotsTxt in request payload", async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true, id: "crawl-job", url: "https://example.com" },
    });

    await startCrawl({ post } as any, {
      url: "https://example.com",
      ignoreRobotsTxt: true,
    });

    expect(post).toHaveBeenCalledWith("/v2/crawl", {
      url: "https://example.com",
      ignoreRobotsTxt: true,
    });
  });

  test("startCrawl omits ignoreRobotsTxt when not set", async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true, id: "crawl-job", url: "https://example.com" },
    });

    await startCrawl({ post } as any, {
      url: "https://example.com",
    });

    expect(post).toHaveBeenCalledWith("/v2/crawl", {
      url: "https://example.com",
    });
  });
});
