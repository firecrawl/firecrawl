import { describe, expect, jest, test } from "@jest/globals";
import { scrape } from "../../../v2/methods/scrape";

function httpMock() {
  return {
    post: jest.fn(async () => ({
      status: 200,
      data: { success: true, data: {} },
    })),
    getTimeoutMs: jest.fn(() => 0),
  } as any;
}

describe("v2 scrape zeroDataRetention", () => {
  test("forwards zeroDataRetention at the top level", async () => {
    const http = httpMock();

    await scrape(http, "https://example.com", { zeroDataRetention: true });

    const payload = http.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.zeroDataRetention).toBe(true);
  });

  test("omits zeroDataRetention when the caller does not set it", async () => {
    const http = httpMock();

    await scrape(http, "https://example.com", { formats: ["markdown"] });

    const payload = http.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("zeroDataRetention");
  });
});
