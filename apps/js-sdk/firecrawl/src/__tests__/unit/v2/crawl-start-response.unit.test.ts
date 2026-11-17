import { describe, test, expect, vi } from "vitest";
import { startCrawl } from "../../../v2/methods/crawl";

function makeHttp(data: Record<string, unknown>) {
  return {
    post: vi.fn(async () => ({ status: 200, data })),
    prepareHeaders: vi.fn(() => undefined),
  } as any;
}

describe("v2 startCrawl response", () => {
  test("returns the options generated from a prompt", async () => {
    const promptGeneratedOptions = { includePaths: ["^/blog/.*"], limit: 50 };
    const finalCrawlerOptions = { includePaths: ["^/blog/.*"], limit: 50, sitemap: "include" };
    const http = makeHttp({
      success: true,
      id: "job",
      url: "https://api.firecrawl.dev/v2/crawl/job",
      promptGeneratedOptions,
      finalCrawlerOptions,
    });

    const res = await startCrawl(http, { url: "https://example.com", prompt: "only the blog" });

    expect(res).toStrictEqual({
      id: "job",
      url: "https://api.firecrawl.dev/v2/crawl/job",
      promptGeneratedOptions,
      finalCrawlerOptions,
    });
  });

  test("keeps the plain shape without a prompt", async () => {
    const http = makeHttp({ success: true, id: "job", url: "https://api.firecrawl.dev/v2/crawl/job" });

    const res = await startCrawl(http, { url: "https://example.com" });

    expect(res).toStrictEqual({ id: "job", url: "https://api.firecrawl.dev/v2/crawl/job" });
  });
});
