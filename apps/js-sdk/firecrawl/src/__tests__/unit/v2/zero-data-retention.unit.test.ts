import { describe, expect, jest, test } from "@jest/globals";
import { scrape } from "../../../v2/methods/scrape";

describe("v2 scrape zero data retention", () => {
  test("scrape accepts and sends zeroDataRetention", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, data: {} },
    }));

    await scrape({ post } as any, "https://example.com", {
      zeroDataRetention: true,
      autoResume: false,
    });

    expect(post).toHaveBeenCalledWith(
      "/v2/scrape",
      { url: "https://example.com", zeroDataRetention: true },
      {},
    );
  });
});
