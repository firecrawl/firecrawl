import { createLogger, type Logger } from "winston";
import { SearchV2Response } from "../lib/entities";
import { normalizeURLForIndex, hashURL, useIndex } from "../services";
import { indexGetRecent5 } from "../db/rpc";
import {
  generateHighlightsIndexedBatch,
  type HighlightIndexedPage,
} from "./highlight-model";
import type { HighlightFailureReason } from "./highlight-model";
import { config } from "../config";
import { logger as rootLogger } from "../lib/logger";

// How far back into the index we're willing to reach for highlight source text.
const HIGHLIGHTS_INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HIGHLIGHTS_API_TIMEOUT_MS = 3000;
const shadowLogger = createLogger({ silent: true });

type SearchHighlightsMode = "apply" | "shadow";

/**
 * Whether the deployment has every dependency indexed highlights need: the
 * index DB (to find cached content), the GCS index bucket (to fetch it), and the
 * highlight model service URL (to score it). Missing any => silently skip.
 */
export function highlightsEnvReady(): boolean {
  return (
    useIndex && !!config.GCS_INDEX_BUCKET_NAME && !!config.HIGHLIGHT_MODEL_URL
  );
}

function sampled(cohortKey: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;

  let hash = 2166136261;
  for (let i = 0; i < cohortKey.length; i++) {
    hash ^= cohortKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0x1_0000_0000) * 100 < percent;
}

export function searchHighlightsMode(options: {
  requested?: boolean;
  origin?: string | null;
  integration?: string | null;
  cohortKey: string;
  rolloutPercent: number;
}): SearchHighlightsMode {
  if (options.requested === true) return "apply";
  if (options.requested === false) return "shadow";

  const origin = (options.origin ?? "").toLowerCase();
  const integration = (options.integration ?? "").toLowerCase();
  if (integration === "cli" || origin === "cli" || origin.startsWith("mcp")) {
    return "apply";
  }

  return sampled(options.cohortKey, options.rolloutPercent)
    ? "apply"
    : "shadow";
}

// Mirrors scrapeURLWithIndex: prefer the newest 2xx entry unless it sits behind
// this many more-recent error entries, in which case we surface the newest one.
const ERROR_COUNT_TO_REGISTER = 3;

async function getIndexObjectForURL(
  url: string,
  logger: Logger,
  logUrl = true,
): Promise<{ name: string; createdAt: string | null } | null> {
  if (!useIndex) {
    return null;
  }

  try {
    const normalizedURL = normalizeURLForIndex(url);
    const urlHash = hashURL(normalizedURL);

    // Match the most common index variant (default scrape options) to maximize
    // hit rate: desktop, ads blocked, no screenshot, no location, no stealth.
    const rows = await indexGetRecent5({
      url_hash: urlHash,
      max_age_ms: HIGHLIGHTS_INDEX_MAX_AGE_MS,
      is_mobile: false,
      block_ads: true,
      feature_screenshot: false,
      feature_screenshot_fullscreen: false,
      location_country: null,
      location_languages: null,
      wait_time_ms: 0,
      is_stealth: false,
      min_age_ms: null,
    });

    if (!rows || rows.length === 0) {
      return null;
    }

    const newest200Index = rows.findIndex(
      x => x.status >= 200 && x.status < 300,
    );
    const selected =
      newest200Index >= ERROR_COUNT_TO_REGISTER || newest200Index === -1
        ? rows[0]
        : rows[newest200Index];

    return {
      name: selected.id + ".json",
      createdAt: selected.created_at,
    };
  } catch (error) {
    logger.warn("highlights: index lookup failed", {
      error: error instanceof Error ? error.message : String(error),
      ...(logUrl ? { url } : {}),
    });
    return null;
  }
}

interface IndexedSearchHighlightTarget {
  url: string;
  apply?: (highlight: string) => void;
}

function indexedSearchHighlightTargets(
  response: SearchV2Response,
): IndexedSearchHighlightTarget[] {
  const targets: IndexedSearchHighlightTarget[] = [];
  for (const result of response.web ?? []) {
    if (!result.url) continue;
    targets.push({
      url: result.url,
      apply: highlight => {
        result.description = highlight;
      },
    });
  }
  for (const result of response.news ?? []) {
    if (!result.url) continue;
    targets.push({
      url: result.url,
      apply: highlight => {
        result.snippet = highlight;
      },
    });
  }
  return targets;
}

async function generateIndexedSearchHighlights(
  targets: IndexedSearchHighlightTarget[],
  query: string,
  logger: Logger,
  requestId: string,
  applyResults: boolean,
): Promise<{
  attempted: number;
  indexHits: number;
  replaced: number;
  succeeded: boolean;
  failureReason?: HighlightFailureReason;
}> {
  const attempted = targets.length;
  const resolved = await Promise.all(
    targets.map(target => getIndexObjectForURL(target.url, logger, false)),
  );
  const pages: HighlightIndexedPage[] = [];
  resolved.forEach((indexRef, index) => {
    if (!indexRef) return;
    pages.push({
      id: String(index),
      url: targets[index].url,
      indexObject: indexRef.name,
    });
  });

  let failureReason: HighlightFailureReason | undefined;
  const results = await generateHighlightsIndexedBatch(query, pages, {
    logger,
    logPayload: false,
    requestId,
    timeoutMs: HIGHLIGHTS_API_TIMEOUT_MS,
    onFailure: reason => {
      failureReason = reason;
    },
  });
  let replaced = 0;
  if (results) {
    for (const page of pages) {
      const highlight = results.get(page.id)?.markdown;
      if (!highlight?.trim()) continue;
      if (applyResults) {
        targets[Number(page.id)].apply?.(highlight);
      }
      replaced++;
    }
  }

  return {
    attempted,
    indexHits: pages.length,
    replaced,
    succeeded: results !== null,
    ...(failureReason ? { failureReason } : {}),
  };
}

export async function runIndexedSearchHighlights(
  response: SearchV2Response,
  query: string,
  logger: Logger,
  options: {
    mode: SearchHighlightsMode;
    requestId: string;
    teamId: string;
  },
): ReturnType<typeof generateIndexedSearchHighlights> {
  const start = Date.now();
  const result = await generateIndexedSearchHighlights(
    indexedSearchHighlightTargets(response),
    query,
    options.mode === "shadow" ? shadowLogger : logger,
    options.requestId,
    options.mode === "apply",
  );
  const summaryLogger = options.mode === "shadow" ? rootLogger : logger;
  summaryLogger.info("Search highlights completed", {
    canonicalLog: "search/highlights",
    mode: options.mode,
    outcome: result.succeeded ? "completed" : "failed",
    requestId: options.requestId,
    teamId: options.teamId,
    attempted: result.attempted,
    indexHits: result.indexHits,
    ...(options.mode === "apply"
      ? { applied: result.replaced }
      : { wouldApply: result.replaced }),
    failureReason: result.failureReason,
    timeTakenMs: Date.now() - start,
  });
  return result;
}
