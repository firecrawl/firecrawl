import { describe, test, expect, jest } from "@jest/globals";
import { map } from "../../../v2/methods/map";

function makeHttp() {
  const post = jest.fn(async () => ({
    status: 200,
    data: { success: true, links: [] },
  }));
  return { post, prepareHeaders: jest.fn(() => undefined) } as any;
}

describe("v2 map ignoreCache payload", () => {
  test("ignoreCache: true is included in the request payload", async () => {
    const http = makeHttp();
    await map(http, "https://example.com", { ignoreCache: true });
    expect(http.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ ignoreCache: true }),
    );
  });

  test("ignoreCache is omitted from payload when not set", async () => {
    const http = makeHttp();
    await map(http, "https://example.com", { limit: 10 });
    expect(http.post.mock.calls[0][1]).not.toHaveProperty("ignoreCache");
  });
});
