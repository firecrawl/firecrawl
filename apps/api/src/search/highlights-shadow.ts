import { createLogger, type Logger } from "winston";
import type { SearchV2Response } from "../lib/entities";
import { config } from "../config";
import { logger as rootLogger } from "../lib/logger";
import {
  highlightsEnvReady,
  runIndexedSearchHighlightsShadow,
  searchHighlightURLs,
} from "./highlights";

const CANONICAL_LOG = "search/highlights-shadow";
const shadowLogger = createLogger({ silent: true });

function sampled(requestId: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;

  let hash = 2166136261;
  for (let i = 0; i < requestId.length; i++) {
    hash ^= requestId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000 < rate;
}

export function createSearchHighlightsShadowRunner(
  canonicalLogger: Pick<Logger, "info" | "warn"> = rootLogger,
): (options: {
  response: SearchV2Response;
  query: string;
  requestId: string;
  teamId: string;
  zeroDataRetention: boolean;
}) => "skipped" | "started" {
  let inFlight = 0;

  return options => {
    if (
      options.zeroDataRetention ||
      !highlightsEnvReady() ||
      !sampled(options.requestId, config.HIGHLIGHT_SHADOW_RATE)
    ) {
      return "skipped";
    }

    const urls = searchHighlightURLs(options.response);
    const { query, requestId, teamId } = options;
    inFlight++;
    const startedAt = Date.now();
    void runIndexedSearchHighlightsShadow(urls, query, shadowLogger, requestId)
      .then(result => {
        canonicalLogger.info("Search highlights shadow completed", {
          canonicalLog: CANONICAL_LOG,
          outcome: result.succeeded ? "completed" : "failed",
          requestId,
          teamId,
          attempted: result.attempted,
          indexHits: result.indexHits,
          wouldReplace: result.replaced,
          failureReason: result.failureReason,
          timeTakenMs: Date.now() - startedAt,
          inFlight,
          sampleRate: config.HIGHLIGHT_SHADOW_RATE,
        });
      })
      .catch(error => {
        canonicalLogger.warn("Search highlights shadow failed", {
          canonicalLog: CANONICAL_LOG,
          outcome: "failed",
          requestId,
          teamId,
          errorType: error instanceof Error ? error.name : "unknown",
          timeTakenMs: Date.now() - startedAt,
          inFlight,
          sampleRate: config.HIGHLIGHT_SHADOW_RATE,
        });
      })
      .finally(() => {
        inFlight--;
      });

    return "started";
  };
}

export const runSearchHighlightsShadow = createSearchHighlightsShadowRunner();
