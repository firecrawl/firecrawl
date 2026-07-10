import { describe, expect, it } from "vitest";
import { getMiniMaxBaseURL, minimaxEndpoints } from "./minimax";

describe("getMiniMaxBaseURL", () => {
  it.each([
    ["global_en", "openai", "https://api.minimax.io/v1"],
    ["global_en", "anthropic", "https://api.minimax.io/anthropic/v1"],
    ["cn_zh", "openai", "https://api.minimaxi.com/v1"],
    ["cn_zh", "anthropic", "https://api.minimaxi.com/anthropic/v1"],
  ] as const)("resolves the %s %s endpoint", (region, apiFormat, expected) => {
    expect(getMiniMaxBaseURL(region, apiFormat)).toBe(expected);
  });

  it("keeps both API formats available in every region", () => {
    expect(Object.values(minimaxEndpoints)).toEqual([
      {
        openai: "https://api.minimax.io/v1",
        anthropic: "https://api.minimax.io/anthropic/v1",
      },
      {
        openai: "https://api.minimaxi.com/v1",
        anthropic: "https://api.minimaxi.com/anthropic/v1",
      },
    ]);
  });
});
