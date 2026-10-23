import { describe, expect, test, vi } from "vitest";
import { map } from "../../../v2/methods/map";

function makeHttp() {
  const post = vi.fn(async () => ({
    status: 200,
    data: { success: true, links: [] },
  }));
  return { post } as any;
}

describe("v2 map option serialization", () => {
  test.each([true, false])(
    "sends ignoreCache when set to %s",
    async (ignoreCache) => {
      const http = makeHttp();

      await map(http, "https://example.com", { ignoreCache });

      expect(http.post).toHaveBeenCalledWith(
        "/v2/map",
        { url: "https://example.com", ignoreCache },
        {},
      );
    },
  );

  test("omits ignoreCache when it is not provided", async () => {
    const http = makeHttp();

    await map(http, "https://example.com");

    expect(http.post.mock.calls[0][1]).not.toHaveProperty("ignoreCache");
  });
});
