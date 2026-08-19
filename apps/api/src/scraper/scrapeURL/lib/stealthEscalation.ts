import type { Meta } from "..";

/**
 * Whether a proxy-blocked response should escalate to a stealth proxy, by
 * throwing AddFeatureError so the scrape loop re-runs with the stealthProxy
 * flag. Only auto escalates, only once, and only when the scrape can actually
 * be retried: with a single engine pinned the error is not caught and would
 * fail the scrape instead.
 */
export function shouldEscalateToStealthProxy(meta: Meta): boolean {
  return (
    meta.options.proxy === "auto" &&
    !meta.featureFlags.has("stealthProxy") &&
    (meta.internalOptions.forceEngine === undefined ||
      Array.isArray(meta.internalOptions.forceEngine))
  );
}
