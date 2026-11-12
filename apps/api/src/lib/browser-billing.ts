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

/** The longest session, in whole seconds, whose charge stays within `credits`. */
export function browserSecondsForCredits(
  credits: number,
  creditsPerHour: number,
): number {
  let seconds = Math.floor((credits * 3600) / creditsPerHour);
  while (
    seconds > 0 &&
    calculateBrowserSessionCredits(seconds * 1000, creditsPerHour) > credits
  )
    seconds--;
  return seconds;
}
