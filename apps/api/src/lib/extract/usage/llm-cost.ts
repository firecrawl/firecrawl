import { TokenUsage } from "../../../controllers/v1/types";
import { config } from "../../../config";
import { logger } from "../../../lib/logger";
import { CostTracking } from "../../cost-tracking";
import { modelPrices } from "./model-prices";

type ServiceTier = "standard" | "priority";

interface PricingTier {
  service_tier: ServiceTier;
  input_tokens_lte?: number;
  input_tokens_gt?: number;
  input_cost_per_token: number;
  output_cost_per_token: number;
}

export interface ModelPricing {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_request?: number;
  pricing_tiers?: PricingTier[];
  mode: string;
}

export function resolveTokenPricing(
  pricing: ModelPricing,
  promptTokens: number,
  serviceTier: ServiceTier = "standard",
) {
  const tier = pricing.pricing_tiers?.find(
    candidate =>
      candidate.service_tier === serviceTier &&
      (candidate.input_tokens_lte === undefined ||
        promptTokens <= candidate.input_tokens_lte) &&
      (candidate.input_tokens_gt === undefined ||
        promptTokens > candidate.input_tokens_gt),
  );

  return {
    inputCostPerToken:
      tier?.input_cost_per_token ?? pricing.input_cost_per_token,
    outputCostPerToken:
      tier?.output_cost_per_token ?? pricing.output_cost_per_token,
  };
}
const tokenPerCharacter = 0.5;
const baseTokenCost = 300;

export function calculateThinkingCost(costTracking: CostTracking): number {
  return Math.ceil(costTracking.toJSON().totalCost * 20000);
}

export function calculateFinalResultCost(data: any): number {
  return Math.floor(
    JSON.stringify(data).length / tokenPerCharacter + baseTokenCost,
  );
}

export function estimateTotalCost(tokenUsage: TokenUsage[]): number {
  return tokenUsage.reduce((total, usage) => {
    return total + estimateCost(usage);
  }, 0);
}

function estimateCost(tokenUsage: TokenUsage): number {
  let totalCost = 0;
  try {
    let model = tokenUsage.model ?? config.MODEL_NAME;
    if (!model) {
      logger.error("No model name provided");
      return 0;
    }

    const pricing = modelPrices[model] as ModelPricing;

    if (!pricing) {
      logger.error(`No pricing information found for model: ${model}`);
      return 0;
    }

    if (pricing.mode !== "chat") {
      logger.error(`Model ${model} is not a chat model`);
      return 0;
    }

    // Add per-request cost if applicable (Only Perplexity supports this)
    if (pricing.input_cost_per_request) {
      totalCost += pricing.input_cost_per_request;
    }

    const { inputCostPerToken, outputCostPerToken } = resolveTokenPricing(
      pricing,
      tokenUsage.promptTokens,
    );

    // Add token-based costs
    if (inputCostPerToken) {
      totalCost += tokenUsage.promptTokens * inputCostPerToken;
    }

    if (outputCostPerToken) {
      totalCost += tokenUsage.completionTokens * outputCostPerToken;
    }

    return Number(totalCost.toFixed(7));
  } catch (error) {
    logger.error(`Error estimating cost: ${error}`);
    return totalCost;
  }
}
