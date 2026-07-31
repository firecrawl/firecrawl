import { describe, expect, jest, test } from "@jest/globals";
import { search } from "../../../v2/methods/search";

const call = {
  provider: "hello",
  capability: "echo",
  options: { value: "test" },
  idempotencyKey: "hello-echo-test",
};

describe("v2 Exchange", () => {
  test("supports an Exchange-only composed search", async () => {
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: {
          success: true,
          data: {
            exchange: [
              {
                provider: "hello",
                capability: "echo",
                data: { value: "test" },
              },
            ],
          },
        },
      })),
    } as any;

    const result = await search(http, { exchange: [call] });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      { exchange: [call] },
      {},
    );
    expect(result.exchange).toEqual([
      expect.objectContaining({
        provider: "hello",
        capability: "echo",
      }),
    ]);
  });

  test("requires a query or Exchange call for search", async () => {
    await expect(search({ post: jest.fn() } as any, {})).rejects.toThrow(
      "Search requires a query or at least one Exchange call",
    );
  });
});
