import {
  countTokens as nativeCountTokens,
  fitToTokensNative as nativeFitToTokens,
  trimToTokenLimitNative as nativeTrimToTokenLimit,
} from "@mendable/firecrawl-rs";

/** Count BPE tokens in text for the given OpenAI model identifier. */
export function countTokens(text: string, modelId: string): number {
  return nativeCountTokens(text, modelId);
}

/** Trim text to at most maxTokens BPE tokens for the given model. */
export function trimToTokenLimitNative(
  text: string,
  maxTokens: number,
  modelId: string,
): {
  text: string;
  numTokens: number;
  originalTokens: number;
  trimmed: boolean;
} {
  return nativeTrimToTokenLimit(text, maxTokens, modelId);
}

/** Fit text to at most maxTokens BPE tokens off the Node.js event loop. */
export async function fitToTokensNative(
  text: string,
  maxTokens: number,
  modelId: string,
): Promise<{ text: string; trimmed: boolean }> {
  return nativeFitToTokens(text, maxTokens, modelId);
}
