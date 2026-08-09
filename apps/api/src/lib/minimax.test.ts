import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelPrices } from "./extract/usage/model-prices";
import { getMiniMaxBaseURL, minimaxEndpoints } from "./minimax";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("getMiniMaxBaseURL", () => {
  it.each([
    ["global_en", "openai", "https://api.minimax.io/v1"],
    ["global_en", "anthropic", "https://api.minimax.io/anthropic"],
    ["cn_zh", "openai", "https://api.minimaxi.com/v1"],
    ["cn_zh", "anthropic", "https://api.minimaxi.com/anthropic"],
  ] as const)("resolves the %s %s endpoint", (region, apiFormat, expected) => {
    expect(getMiniMaxBaseURL(region, apiFormat)).toBe(expected);
  });

  it("keeps both API formats available in every region", () => {
    expect(Object.values(minimaxEndpoints)).toEqual([
      {
        openai: "https://api.minimax.io/v1",
        anthropic: "https://api.minimax.io/anthropic",
      },
      {
        openai: "https://api.minimaxi.com/v1",
        anthropic: "https://api.minimaxi.com/anthropic",
      },
    ]);
  });

  it.each([
    ["global_en", "openai", "https://api.minimax.io/v1/chat/completions"],
    ["global_en", "anthropic", "https://api.minimax.io/anthropic/v1/messages"],
    ["cn_zh", "openai", "https://api.minimaxi.com/v1/chat/completions"],
    ["cn_zh", "anthropic", "https://api.minimaxi.com/anthropic/v1/messages"],
  ] as const)(
    "sends %s %s requests to %s",
    async (region, apiFormat, expectedURL) => {
      vi.stubEnv("MINIMAX_API_KEY", "test-api-key");
      vi.stubEnv("MINIMAX_REGION", region);
      vi.stubEnv("MINIMAX_API_FORMAT", apiFormat);
      vi.stubEnv("MODEL_PROVIDER", "minimax");
      vi.stubEnv("MODEL_NAME", "MiniMax-M3");

      let requestURL = "";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          requestURL = input instanceof Request ? input.url : String(input);
          throw new Error("Request captured");
        }),
      );

      const { getModel } = await import("./generic-ai.js");
      await expect(
        generateText({
          model: getModel("MiniMax-M3"),
          prompt: "Hello",
          maxRetries: 0,
        }),
      ).rejects.toThrow();

      expect(requestURL).toBe(expectedURL);
    },
  );
});

describe("MiniMax model configuration", () => {
  it("uses the configured context windows and token prices", () => {
    expect(modelPrices["MiniMax-M3"]).toMatchObject({
      max_input_tokens: 1000000,
      input_cost_per_token: 6e-7,
      output_cost_per_token: 0.0000024,
      cache_read_input_token_cost: 1.2e-7,
      supported_modalities: ["text", "image", "video"],
    });
    expect(modelPrices["MiniMax-M2.7"]).toMatchObject({
      max_input_tokens: 204800,
      input_cost_per_token: 3e-7,
      output_cost_per_token: 0.0000012,
      cache_read_input_token_cost: 6e-8,
      cache_creation_input_token_cost: 3.75e-7,
      supported_modalities: ["text"],
    });
  });
});
