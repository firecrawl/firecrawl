import type { Meta } from "..";

/**
 * Whether a proxy-blocked response should escalate to a stealth proxy, by
 * throwing AddFeatureError so the scrape loop re-runs with the stealthProxy
 * flag. Only auto escalates, and only once.
 */
export function shouldEscalateToStealthProxy(meta: Meta): boolean {
  return (
    meta.options.proxy === "auto" && !meta.featureFlags.has("stealthProxy")
  );
}
