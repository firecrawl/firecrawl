import type { Meta } from "..";

/**
 * Whether a scrape that looks proxy-blocked may escalate to a stealth proxy.
 *
 * Escalation works by throwing AddFeatureError so the scrape loop re-runs with
 * the stealthProxy flag, which only happens when the engine is not pinned to a
 * single one — with a pinned engine the error propagates and fails the scrape
 * instead.
 */
export function canEscalateToStealthProxy(meta: Meta): boolean {
  return (
    meta.options.proxy === "auto" &&
    !meta.featureFlags.has("stealthProxy") &&
    (meta.internalOptions.forceEngine === undefined ||
      Array.isArray(meta.internalOptions.forceEngine))
  );
}
