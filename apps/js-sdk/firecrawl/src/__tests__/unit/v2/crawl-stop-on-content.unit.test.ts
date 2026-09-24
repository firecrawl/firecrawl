import { describe, test, expect, jest } from "@jest/globals";
import { startCrawl } from "../../../v2/methods/crawl";

function makeHttp() {
  const post = jest.fn(async () => ({
    status: 200,
    data: { success: true, id: "job", url: "u" },
  }));
  return {
    post,
    prepareHeaders: jest.fn(() => undefined),
  } as any;
}

describe("v2 crawl stopOnContent serialization", () => {
  test("sends stopOnContent when provided", async () => {
    const http = makeHttp();
    await startCrawl(http, {
      url: "https://example.com/release-notes",
      stopOnContent: ["No release notes found"],
    });
    expect(http.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ stopOnContent: ["No release notes found"] }),
    );
  });

  test("omits stopOnContent when not provided", async () => {
    const http = makeHttp();
    await startCrawl(http, { url: "https://example.com" });
    expect(http.post.mock.calls[0][1]).not.toHaveProperty("stopOnContent");
  });
});
