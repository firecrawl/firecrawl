/**
 * Deterministic percentage sampling for gradual rollouts.
 *
 * The bucket is a pure function of the cohort key, so a cohort that is in at
 * 5% is still in at 30% — a ramp only ever adds, never reshuffles. That is the
 * property `Math.random() < percent` does not have, and the reason to prefer
 * this wherever a cohort should stay on one side of a rollout: billing routes,
 * anything a support question could be asked about, anything you want to
 * compare before and after.
 *
 * FNV-1a over the key, mapped onto [0, 100).
 */
export function sampled(cohortKey: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;

  let hash = 2166136261;
  for (let i = 0; i < cohortKey.length; i++) {
    hash ^= cohortKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0x1_0000_0000) * 100 < percent;
}
