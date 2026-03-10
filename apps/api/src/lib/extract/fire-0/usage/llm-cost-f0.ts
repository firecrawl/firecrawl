import { TokenUsage } from "../../../../controllers/v1/types";
import { config } from "../../../../config";
import { logger } from "../../../../lib/logger";
import { modelPrices } from "../../usage/model-prices";

interface ModelPricing {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_request?: number;
  mode: string;
}
const tokenPerCharacter = 4;
const baseTokenCost = 300;

export function calculateFinalResultCost_F0(data: any): number {
  return Math.floor(
    JSON.stringify(data).length / tokenPerCharacter + baseTokenCost,
  );
}

export function estimateTotalCost_F0(tokenUsage: TokenUsage[]): number {
  return tokenUsage.reduce((total, usage) => {
    return total + estimateCost_F0(usage);
  }, 0);
}

export function estimateCost_F0(tokenUsage: TokenUsage): number {
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

    // Add token-based costs
    if (pricing.input_cost_per_token) {
      totalCost += tokenUsage.promptTokens * pricing.input_cost_per_token;
    }

    if (pricing.output_cost_per_token) {
      totalCost += tokenUsage.completionTokens * pricing.output_cost_per_token;
    }

    return Number(totalCost.toFixed(7));
  } catch (error) {
    logger.error(`Error estimating cost: ${error}`);
    return totalCost;
  }
}
