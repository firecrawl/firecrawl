import { jest } from "@jest/globals";
import { FirecrawlClient } from "../../../v2/client";

describe("v2.search unit", () => {
  test("forwards documented country and enterprise search fields", async () => {
    const client = new FirecrawlClient({ apiUrl: "http://localhost:3000" });
    const post = jest.fn(async () => ({
      status: 200,
      data: {
        success: true,
        data: {
          web: [],
        },
      },
    }));

    (client as any).http = { post };

    await client.search("restaurants", {
      country: "DE",
      enterprise: ["zdr"],
      limit: 5,
    });

    expect(post).toHaveBeenCalledWith(
      "/v2/search",
      expect.objectContaining({
        query: "restaurants",
        country: "DE",
        enterprise: ["zdr"],
        limit: 5,
      }),
      {},
    );
  });
});
