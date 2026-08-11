/**
 * Minimal unit test for v2 scrape (no mocking; sanity check payload path)
 */
import { FirecrawlClient } from "../../../v2/client";
import { scrape } from "../../../v2/methods/scrape";
import { jest } from "@jest/globals";

describe("v2.scrape unit", () => {
  test("constructor allows the keyless free tier", () => {
    expect(() => new FirecrawlClient({ apiKey: "", apiUrl: "https://api.firecrawl.dev" })).not.toThrow();
  });

  test("sends pageMarkdown and returns typed PDF pages", async () => {
    const http = {
      post: jest.fn().mockResolvedValue({
        status: 200,
        data: {
          success: true,
          data: {
            markdown: "one\ntwo",
            pages: [
              { pageNumber: 1, markdown: "one" },
              { pageNumber: 2, markdown: "two" },
            ],
          },
        },
      }),
    } as any;

    const document = await scrape(http, "https://example.com/file.pdf", {
      parsers: [{ type: "pdf", mode: "auto", pageMarkdown: true }],
    });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/scrape",
      expect.objectContaining({
        parsers: [{ type: "pdf", mode: "auto", pageMarkdown: true }],
      }),
      {},
    );
    expect(document.pages).toEqual([
      { pageNumber: 1, markdown: "one" },
      { pageNumber: 2, markdown: "two" },
    ]);
  });
});
