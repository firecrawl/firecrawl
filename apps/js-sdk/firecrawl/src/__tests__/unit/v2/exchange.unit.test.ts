import { describe, expect, jest, test } from "@jest/globals";
import { exchangeInvoke } from "../../../v2/methods/exchange";
import { search } from "../../../v2/methods/search";

const call = {
  provider: "hello",
  capability: "echo",
  options: { value: "test" },
  idempotencyKey: "hello-echo-test",
};

describe("v2 Exchange", () => {
  test("invokes the canonical Exchange endpoint", async () => {
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: {
          success: true,
          partial: false,
          creditsUsed: 2,
          id: "job-1",
          data: {
            exchange: [
              {
                provider: "hello",
                capability: "echo",
                delivery: "direct",
                creditsCost: 2,
                data: { value: "test" },
              },
            ],
          },
        },
      })),
    } as any;

    const result = await exchangeInvoke(http, {
      calls: [call],
      timeout: 10_000,
      zeroDataRetention: true,
    });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/exchange/invoke",
      {
        calls: [call],
        timeout: 10_000,
        zeroDataRetention: true,
      },
      { timeoutMs: 15_000 },
    );
    expect(result).toEqual({
      exchange: [
        expect.objectContaining({
          provider: "hello",
          capability: "echo",
          data: { value: "test" },
        }),
      ],
      creditsUsed: 2,
      id: "job-1",
      partial: false,
    });
  });

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
