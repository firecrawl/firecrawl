import type { Logger } from "winston";
import { SearchV2Response } from "../lib/entities";
import {
  normalizeURLForIndex,
  hashURL,
  getIndexFromGCS,
  useIndex,
} from "../services";
import { indexGetRecent5 } from "../db/rpc";
import { parseMarkdown } from "../lib/html-to-markdown";
import { htmlTransform } from "../scraper/scrapeURL/lib/removeUnwantedElements";
import type { ScrapeOptions } from "../controllers/v2/types";
import { generateSemanticHighlights } from "./highlight-model";
import { config } from "../config";

// How far back into the index we're willing to reach for highlight source text.
const HIGHLIGHTS_INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Whether the deployment has every dependency the highlights beta needs: the
 * index DB (to find cached content), the GCS index bucket (to fetch it), and the
 * highlight model endpoint (to score it). Missing any => silently skip.
 */
export function highlightsEnvReady(): boolean {
  return (
    useIndex && !!config.GCS_INDEX_BUCKET_NAME && !!config.HIGHLIGHT_MODEL_URL
  );
}

// Mirrors scrapeURLWithIndex: prefer the newest 2xx entry unless it sits behind
// this many more-recent error entries, in which case we surface the newest one.
const ERROR_COUNT_TO_REGISTER = 3;

// This whole module runs out-of-line from scrapeURL on purpose: it reads
// already-indexed content directly from the index DB + GCS instead of routing
// through the scrape engine. That keeps highlight generation off the critical
// scrape path and lets us experiment with latency freely.

/**
 * Fetch the most recent indexed markdown for a URL within the last 30 days.
 * Returns null when the URL isn't in the index (or the lookup fails) so callers
 * can fall back to the provider snippet.
 */
async function getIndexedMarkdownForURL(
  url: string,
  logger: Logger,
): Promise<string | null> {
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

    const doc = await getIndexFromGCS(
      selected.id + ".json",
      logger.child({ module: "search/highlights", method: "getIndexFromGCS" }),
    );
    if (!doc || !doc.html) {
      return null;
    }

    // Skip raw base64 PDFs — they aren't useful as highlight source text.
    if (typeof doc.html === "string" && doc.html.startsWith("JVBERi")) {
      return null;
    }

    // The index stores rawHtml, so we must run the same cleaning the scrape
    // pipeline does (strip <style>/<script>/nav, extract main content) before
    // converting to markdown — otherwise CSS/JS leaks in and pollutes the
    // highlight source text.
    const cleanedHtml = await htmlTransform(doc.html, url, {
      onlyMainContent: true,
      includeTags: [],
      excludeTags: [],
    } as unknown as ScrapeOptions);

    const markdown = await parseMarkdown(cleanedHtml, { logger });
    return markdown && markdown.trim() !== "" ? markdown : null;
  } catch (error) {
    logger.warn("highlights: index lookup failed", {
      error: error instanceof Error ? error.message : String(error),
      url,
    });
    return null;
  }
}

async function highlightOne(
  url: string,
  query: string,
  logger: Logger,
  apply: (highlights: string) => void,
  counters: { indexHits: number; replaced: number },
): Promise<void> {
  const markdown = await getIndexedMarkdownForURL(url, logger);
  if (!markdown) {
    return;
  }
  counters.indexHits++;

  const highlights = await generateSemanticHighlights(markdown, query, {
    logger,
  });
  if (highlights && highlights.trim() !== "") {
    apply(highlights);
    counters.replaced++;
  }
}

/**
 * For each search result, in parallel: look up the URL in our index (last 30
 * days), and if present, replace the provider snippet with query-relevant
 * highlights generated from the indexed content. Mutates `response` in place.
 * Results not in the index keep their original snippet.
 */
export async function applySearchHighlights(
  response: SearchV2Response,
  query: string,
  logger: Logger,
): Promise<{ attempted: number; indexHits: number; replaced: number }> {
  const counters = { indexHits: 0, replaced: 0 };
  const tasks: Promise<void>[] = [];
  const start = Date.now();

  // Web results carry the snippet in `description` — replace it in place.
  for (const result of response.web ?? []) {
    if (!result.url) continue;
    tasks.push(
      highlightOne(result.url, query, logger, h => {
        result.description = h;
      }, counters),
    );
  }

  // News results carry the snippet in `snippet` — replace it in place.
  for (const result of response.news ?? []) {
    if (!result.url) continue;
    const url = result.url;
    tasks.push(
      highlightOne(url, query, logger, h => {
        result.snippet = h;
      }, counters),
    );
  }

  const attempted = tasks.length;
  await Promise.all(tasks);

  logger.info("Search highlights applied", {
    attempted,
    indexHits: counters.indexHits,
    replaced: counters.replaced,
    timeTakenMs: Date.now() - start,
  });

  return { attempted, indexHits: counters.indexHits, replaced: counters.replaced };
}
