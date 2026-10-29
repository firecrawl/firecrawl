import { createHash } from "node:crypto";
import type { Engine } from "./engines";
import { AddFeatureError, EngineError, SiteError } from "./error";

const ROLLOUTS = {
  "tunnel-error-retry": 0.5,
  "skip-enhanced-retry-after-site-protection": 0.2,
  "basic-retry-on-429": 0.5,
} as const;

export type WaterfallExperiment = keyof typeof ROLLOUTS;

export function waterfallExperimentFor(
  engine: Engine,
  error: unknown,
  nextEngine: Engine | undefined,
): WaterfallExperiment | undefined {
  if (
    error instanceof SiteError &&
    error.errorCode.includes("ERR_TUNNEL_CONNECTION_FAILED") &&
    ((engine === "fire-engine;chrome-cdp" &&
      nextEngine === "fire-engine(retry);chrome-cdp") ||
      (engine === "fire-engine;chrome-cdp;stealth" &&
        nextEngine === "fire-engine(retry);chrome-cdp;stealth"))
  ) {
    return "tunnel-error-retry";
  }
  if (
    engine === "fire-engine;chrome-cdp;stealth" &&
    nextEngine === "fire-engine(retry);chrome-cdp;stealth" &&
    error instanceof EngineError &&
    (error.cause as { status?: { failureReason?: string } } | undefined)?.status
      ?.failureReason === "site_protection"
  ) {
    return "skip-enhanced-retry-after-site-protection";
  }
  if (
    engine === "fire-engine;chrome-cdp" &&
    nextEngine === "fire-engine(retry);chrome-cdp" &&
    error instanceof AddFeatureError &&
    error.statusCode === 429
  ) {
    return "basic-retry-on-429";
  }
  return undefined;
}

export function inWaterfallExperimentArm(
  scrapeId: string,
  experiment: WaterfallExperiment,
): boolean {
  const bucket =
    createHash("sha256")
      .update(`${scrapeId}:${experiment}`)
      .digest()
      .readUInt32BE(0) /
    2 ** 32;
  return bucket < ROLLOUTS[experiment];
}
