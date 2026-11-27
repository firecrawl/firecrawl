import { afterEach, describe, test, expect, vi } from "vitest";
import { FirecrawlClient } from "../../../v2/client";
import { browser } from "../../../v2/methods/browser";
import { HttpClient } from "../../../v2/utils/httpClient";

describe("JS SDK v2 browser", () => {
  afterEach(() => vi.restoreAllMocks());

  test("sends location when creating a session", async () => {
    const post = vi.fn(async () => ({
      status: 200,
      data: { success: true, id: "session-1" },
    }));

    await browser({ post } as any, { location: { country: "GB" } });

    expect(post).toHaveBeenCalledWith("/v2/browser", {
      location: { country: "GB" },
    });
  });

  test("omits location by default", async () => {
    const post = vi.fn(async () => ({
      status: 200,
      data: { success: true, id: "session-1" },
    }));

    await browser({ post } as any);

    expect(post).toHaveBeenCalledWith("/v2/browser", {});
  });
  test.each([true, false])("sends recordSession=%s alongside browser options", async (recordSession) => {
    const post = vi.fn(async () => ({
      status: 200,
      data: { success: true, id: "session-1" },
    }));
    const options = { recordSession, blockAds: false, location: { country: "GB" } };

    await browser({ post } as any, options);

    expect(post).toHaveBeenCalledWith("/v2/browser", options);
  });

  test.each([true, false, undefined])(
    "public client preserves recordSession=%s through request preparation",
    async (recordSession) => {
      const post = vi.spyOn(HttpClient.prototype, "post").mockResolvedValue({
        status: 200,
        data: { success: true, id: "session-1" },
      } as any);
      const client = new FirecrawlClient({ apiKey: "fc-test" });

      const response = await client.browser({
        recordSession,
        blockAds: false,
        location: { country: "GB" },
      });

      expect(post).toHaveBeenCalledExactlyOnceWith("/v2/browser", {
        ...(recordSession === undefined ? {} : { recordSession }),
        blockAds: false,
        location: { country: "GB" },
      });
      expect(response.id).toBe("session-1");
    },
  );
});
