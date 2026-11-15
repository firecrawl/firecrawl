export const ALEXANDRIA_FEEDBACK_MAX_TOKENS = 20;

/**
 * Collects feedback tokens from Alexandria call results for a session rating:
 * skips results without one, dedupes, and keeps the newest 20 (newest last).
 */
export function collectFeedbackTokens(
  results: ReadonlyArray<{ feedbackToken?: string } | null | undefined>,
): string[] {
  const tokens: string[] = [];
  for (const result of results) {
    const token = result?.feedbackToken;
    if (!token) continue;
    const seen = tokens.indexOf(token);
    if (seen !== -1) tokens.splice(seen, 1);
    tokens.push(token);
  }
  return tokens.slice(-ALEXANDRIA_FEEDBACK_MAX_TOKENS);
}
