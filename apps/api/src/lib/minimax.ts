export const minimaxEndpoints = {
  global_en: {
    openai: "https://api.minimax.io/v1",
    anthropic: "https://api.minimax.io/anthropic/v1",
  },
  cn_zh: {
    openai: "https://api.minimaxi.com/v1",
    anthropic: "https://api.minimaxi.com/anthropic/v1",
  },
} as const;

export const minimaxRegions = ["global_en", "cn_zh"] as const;
export const minimaxApiFormats = ["openai", "anthropic"] as const;

export type MiniMaxRegion = (typeof minimaxRegions)[number];
export type MiniMaxApiFormat = (typeof minimaxApiFormats)[number];

export function getMiniMaxBaseURL(
  region: MiniMaxRegion,
  apiFormat: MiniMaxApiFormat,
) {
  return minimaxEndpoints[region][apiFormat];
}
