import { describe, expect, jest, test } from "@jest/globals";
import { startCrawl } from "../../../v2/methods/crawl";

describe("crawl start options", () => {
  test("returns prompt-generated and final effective options", async () => {
    const response = {
      status: 200,
      data: {
        success: true,
        id: "crawl-id",
        url: "https://api.firecrawl.dev/v2/crawl/crawl-id",
        promptGeneratedOptions: { includePaths: ["/docs/*"], limit: 100 },
        finalCrawlerOptions: { includePaths: ["/docs/*"], limit: 20 },
      },
    };
    const http = { post: jest.fn(async () => response) } as any;

    const result = await startCrawl(http, {
      url: "https://example.com",
      prompt: "Find docs",
    });

    expect(result.promptGeneratedOptions).toEqual(
      response.data.promptGeneratedOptions,
    );
    expect(result.finalCrawlerOptions).toEqual(response.data.finalCrawlerOptions);
  });
});
