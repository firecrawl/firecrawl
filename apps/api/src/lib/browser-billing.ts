export const BROWSER_CREDITS_PER_HOUR = 120;
export const INTERACT_CREDITS_PER_HOUR = 420;
// Zero Data Retention surcharge, added on top of either rate (+2 credits/min).
export const BROWSER_ZDR_CREDITS_PER_HOUR = 120;

export function browserCreditsPerHour(
  usedPrompt: boolean,
  zeroDataRetention: boolean,
): number {
  return (
    (usedPrompt ? INTERACT_CREDITS_PER_HOUR : BROWSER_CREDITS_PER_HOUR) +
    (zeroDataRetention ? BROWSER_ZDR_CREDITS_PER_HOUR : 0)
  );
}

export function calculateBrowserSessionCredits(
  durationMs: number,
  creditsPerHour = BROWSER_CREDITS_PER_HOUR,
): number {
  const hours = durationMs / 3_600_000;
  const minCredits = Math.ceil(creditsPerHour / 60);
  return Math.max(minCredits, Math.ceil(hours * creditsPerHour));
}
