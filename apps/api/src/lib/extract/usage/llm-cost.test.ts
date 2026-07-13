import { describe, expect, it, vi } from "vitest";
import { estimateCost_F0 } from "../fire-0/usage/llm-cost-f0";
import {
  estimateTotalCost,
  type ModelPricing,
  resolveTokenPricing,
} from "./llm-cost";
import { modelPrices } from "./model-prices";

vi.mock("../../../config", () => ({ config: {} }));
vi.mock("../../../lib/logger", () => ({
  logger: { error: vi.fn() },
}));

const pricing = modelPrices["MiniMax-M3"] as ModelPricing;

describe("MiniMax-M3 pricing", () => {
  it.each([
    ["standard", 512000, 3e-7, 0.0000012],
    ["standard", 512001, 6e-7, 0.0000024],
    ["priority", 512000, 4.5e-7, 0.0000018],
    ["priority", 512001, 9e-7, 0.0000036],
  ] as const)(
    "selects the %s tier for %i input tokens",
    (serviceTier, promptTokens, inputCost, outputCost) => {
      expect(resolveTokenPricing(pricing, promptTokens, serviceTier)).toEqual({
        inputCostPerToken: inputCost,
        outputCostPerToken: outputCost,
      });
    },
  );

  it("uses the standard long-context tier in both cost estimators", () => {
    const usage = {
      model: "MiniMax-M3",
      promptTokens: 512001,
      completionTokens: 100,
      totalTokens: 512101,
    };

    expect(estimateTotalCost([usage])).toBe(0.3074406);
    expect(estimateCost_F0(usage)).toBe(0.3074406);
  });
});
