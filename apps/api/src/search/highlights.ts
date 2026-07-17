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
import {
  generateHighlightsBatch,
  generateHighlightsIndexedBatch,
  type HighlightIndexedPage,
} from "./highlight-model";
import type { HighlightFailureReason } from "./highlight-model";
import { config } from "../config";

// How far back into the index we're willing to reach for highlight source text.
const HIGHLIGHTS_INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Whether the deployment has every dependency the highlights beta needs: the
 * index DB (to find cached content), the GCS index bucket (to fetch it), and the
 * highlight model service URL (to score it). Missing any => silently skip.
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
  logUrl = true,
): Promise<string | null> {
  const indexRef = await getIndexObjectForURL(url, logger, logUrl);
  if (!indexRef) {
    return null;
  }

  try {
    const doc = await getIndexFromGCS(
      indexRef.name,
      logger.child({ module: "search/highlights", method: "getIndexFromGCS" }),
      { indexCreatedAt: indexRef.createdAt },
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
    logger.warn("highlights: index content load failed", {
      error: error instanceof Error ? error.message : String(error),
      ...(logUrl ? { url } : {}),
    });
    return null;
  }
}

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

export function searchHighlightURLs(response: SearchV2Response): string[] {
  return indexedSearchHighlightTargets(response).map(target => target.url);
}

async function runIndexedSearchHighlights(
  targets: IndexedSearchHighlightTarget[],
  query: string,
  logger: Logger,
  requestId: string,
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
    timeoutMs: null,
    onFailure: reason => {
      failureReason = reason;
    },
  });
  let replaced = 0;
  if (results) {
    for (const page of pages) {
      const highlight = results.get(page.id)?.markdown;
      if (!highlight?.trim()) continue;
      targets[Number(page.id)].apply?.(highlight);
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

export async function applyIndexedSearchHighlights(
  response: SearchV2Response,
  query: string,
  logger: Logger,
  requestId: string,
): ReturnType<typeof runIndexedSearchHighlights> {
  const start = Date.now();
  const result = await runIndexedSearchHighlights(
    indexedSearchHighlightTargets(response),
    query,
    logger,
    requestId,
  );
  logger.info("Search highlights applied", {
    attempted: result.attempted,
    indexHits: result.indexHits,
    replaced: result.replaced,
    timeTakenMs: Date.now() - start,
  });
  return result;
}

export function runIndexedSearchHighlightsShadow(
  urls: string[],
  query: string,
  logger: Logger,
  requestId: string,
): ReturnType<typeof runIndexedSearchHighlights> {
  return runIndexedSearchHighlights(
    urls.map(url => ({ url })),
    query,
    logger,
    requestId,
  );
}

/**
 * For each search result: look up the URL in our index (last 30 days), and if
 * present, replace the provider snippet with query-relevant highlights generated
 * from the indexed content. Index lookups run in parallel; each hit's full
 * markdown pages are sent to the highlight model service in one batch, which
 * returns each page's selected highlights reassembled into a single markdown
 * document. Mutates `response` in place. Results not in the index keep their
 * original snippet.
 */
export async function applySearchHighlights(
  response: SearchV2Response,
  query: string,
  logger: Logger,
  options: {
    applyResults?: boolean;
    suppressSummaryLog?: boolean;
    suppressPayloadLog?: boolean;
    allowLegacyFallback?: boolean;
    requestId?: string;
  } = {},
): Promise<{
  attempted: number;
  indexHits: number;
  replaced: number;
  succeeded: boolean;
  failureReason?: HighlightFailureReason;
}> {
  const start = Date.now();
  const applyResults = options.applyResults ?? true;

  // Collect every result we could highlight, each with a setter for its snippet
  // field: web results carry it in `description`, news results in `snippet`.
  const targets: { url: string; apply: (h: string) => void }[] = [];
  for (const result of response.web ?? []) {
    if (!result.url) continue;
    targets.push({
      url: result.url,
      apply: h => {
        result.description = h;
      },
    });
  }
  for (const result of response.news ?? []) {
    if (!result.url) continue;
    targets.push({
      url: result.url,
      apply: h => {
        result.snippet = h;
      },
    });
  }

  const attempted = targets.length;
  if (attempted === 0) {
    return { attempted, indexHits: 0, replaced: 0, succeeded: true };
  }

  // Look up indexed markdown for every URL in parallel, keeping the markdown for
  // each hit so we can send it to the highlight model service.
  const markdowns = await Promise.all(
    targets.map(t =>
      getIndexedMarkdownForURL(t.url, logger, !options.suppressPayloadLog),
    ),
  );
  const hits: {
    apply: (h: string) => void;
    markdown: string;
  }[] = [];
  markdowns.forEach((markdown, i) => {
    if (!markdown) return;
    hits.push({ apply: targets[i].apply, markdown });
  });
  const indexHits = hits.length;

  // Send every hit in one request. IDs are local batch indexes, so a missing or
  // empty response only falls back the corresponding provider snippet.
  let replaced = 0;
  let succeeded = true;
  let failureReason: HighlightFailureReason | undefined;
  if (indexHits > 0) {
    const results = await generateHighlightsBatch(
      query,
      hits.map((hit, index) => ({
        id: String(index),
        markdown: hit.markdown,
      })),
      options.suppressPayloadLog || options.allowLegacyFallback === false
        ? {
            logger,
            logPayload: !options.suppressPayloadLog,
            allowLegacyFallback: options.allowLegacyFallback,
            ...(options.requestId ? { requestId: options.requestId } : {}),
            onFailure: reason => {
              failureReason = reason;
            },
          }
        : {
            logger,
            ...(options.requestId ? { requestId: options.requestId } : {}),
            onFailure: reason => {
              failureReason = reason;
            },
          },
    );
    succeeded = results !== null;
    if (results) {
      hits.forEach((hit, index) => {
        const snippet = results.get(String(index))?.markdown;
        if (snippet?.trim()) {
          if (applyResults) {
            hit.apply(snippet);
          }
          replaced++;
        }
      });
    }
  }

  if (!options.suppressSummaryLog) {
    logger.info("Search highlights applied", {
      attempted,
      indexHits,
      replaced,
      timeTakenMs: Date.now() - start,
    });
  }

  return {
    attempted,
    indexHits,
    replaced,
    succeeded,
    ...(failureReason ? { failureReason } : {}),
  };
}
