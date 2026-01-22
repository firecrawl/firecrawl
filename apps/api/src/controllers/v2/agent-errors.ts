const MAX_CREDITS_ERROR_MESSAGE = "Max credits limit reached";

export const isMaxCreditsError = (error?: string | null) =>
  typeof error === "string" && /max[\s_-]*credits/i.test(error);

export const normalizeMaxCreditsError = (error?: string | null) =>
  isMaxCreditsError(error) ? MAX_CREDITS_ERROR_MESSAGE : (error ?? undefined);
