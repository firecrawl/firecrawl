import { createHash } from "node:crypto";
import type { Engine } from "./engines";
import { SiteError } from "./error";

const ROLLOUTS = {
  "tunnel-error-retry": 0.5,
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
