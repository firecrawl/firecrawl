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
import { generateHighlights } from "./highlight-model";
import { config } from "../config";

// How far back into the index we're willing to reach for highlight source text.
const HIGHLIGHTS_INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Hard cap on the whole highlights pass. Highlights run on every search by
// default, so they must never add more than this to search latency — when the
// deadline fires we abort the in-flight model calls, keep every provider
// snippet, and log a warning.
const HIGHLIGHTS_TIMEOUT_MS = 300;

/**
 * Whether the deployment has every dependency the highlights beta needs: the
 * index DB (to find cached content), the GCS index bucket (to fetch it), and the
 * highlight model service URL + token (to score it). Missing any => silently
 * skip.
 */
export function highlightsEnvReady(): boolean {
  return (
    useIndex &&
    !!config.GCS_INDEX_BUCKET_NAME &&
    !!config.HIGHLIGHT_MODEL_URL &&
    !!config.HIGHLIGHT_MODEL_TOKEN
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
 * can fall back to the provider snippet. An aborted `signal` (the overall
 * highlights deadline) makes it bail with null at the next stage boundary —
 * the individual DB/GCS/parse calls aren't cancelable, but this keeps a
 * timed-out pass from continuing through the remaining expensive stages.
 */
async function getIndexedMarkdownForURL(
  url: string,
  logger: Logger,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!useIndex || signal?.aborted) {
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

    if (!rows || rows.length === 0 || signal?.aborted) {
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
      { indexCreatedAt: selected.created_at },
    );
    if (!doc || !doc.html || signal?.aborted) {
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
    if (signal?.aborted) {
      return null;
    }

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

/**
 * For each search result: look up the URL in our index (last 30 days), and if
 * present, replace the provider snippet with query-relevant highlights generated
 * from the indexed content. Index lookups run in parallel; each hit's full
 * markdown is sent to the highlight model service, which returns the selected
 * highlights reassembled into a single markdown document. Mutates `response` in
 * place. Results not in the index keep their original snippet.
 *
 * The whole pass is capped at HIGHLIGHTS_TIMEOUT_MS: past the deadline every
 * result keeps its provider snippet, even if some highlights came back in time.
 * Time taken is always canonical-logged — debug when within the deadline, warn
 * when it fires.
 */
export async function applySearchHighlights(
  response: SearchV2Response,
  query: string,
  logger: Logger,
): Promise<{
  attempted: number;
  indexHits: number;
  replaced: number;
  timedOut: boolean;
}> {
  const start = Date.now();

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
    logger.debug("Search highlights applied", {
      canonicalLog: "search/highlights",
      attempted,
      indexHits: 0,
      replaced: 0,
      timedOut: false,
      timeTakenMs: Date.now() - start,
      timeoutMs: HIGHLIGHTS_TIMEOUT_MS,
    });
    return { attempted, indexHits: 0, replaced: 0, timedOut: false };
  }

  // Race the pass against the deadline. On timeout, abort the in-flight model
  // calls and bail without touching the response — the dangling work can't
  // mutate it, because all snippet mutations happen below, and only when the
  // work wins the race.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIGHLIGHTS_TIMEOUT_MS);

  let indexHits = 0;
  let replaced = 0;
  let timedOut = false;
  try {
    const work = (async () => {
      // Look up indexed markdown for every URL in parallel, keeping the
      // markdown for each hit so we can send it to the highlight model service.
      const markdowns = await Promise.all(
        targets.map(t =>
          getIndexedMarkdownForURL(t.url, logger, controller.signal),
        ),
      );
      if (controller.signal.aborted) {
        return { hits: [], results: [] };
      }
      const hits: {
        apply: (h: string) => void;
        markdown: string;
      }[] = [];
      markdowns.forEach((markdown, i) => {
        if (!markdown) return;
        hits.push({ apply: targets[i].apply, markdown });
      });

      // Send each hit's full markdown to the highlight model service in
      // parallel and use the reassembled markdown it returns as the snippet.
      const results = await Promise.all(
        hits.map(h =>
          generateHighlights(query, h.markdown, {
            logger,
            signal: controller.signal,
          }),
        ),
      );

      return { hits, results };
    })();

    const finished = await Promise.race([
      work,
      new Promise<null>(resolve =>
        controller.signal.addEventListener("abort", () => resolve(null), {
          once: true,
        }),
      ),
    ]);

    if (finished === null) {
      timedOut = true;
    } else {
      indexHits = finished.hits.length;
      finished.results.forEach((result, i) => {
        if (!result) return;
        const snippet = result.markdown;
        if (snippet.trim() !== "") {
          finished.hits[i].apply(snippet);
          replaced++;
        }
      });
    }
  } finally {
    clearTimeout(timer);
  }

  const timeTakenMs = Date.now() - start;
  const logFields = {
    canonicalLog: "search/highlights",
    attempted,
    indexHits,
    replaced,
    timedOut,
    timeTakenMs,
    timeoutMs: HIGHLIGHTS_TIMEOUT_MS,
  };
  if (timedOut) {
    logger.warn("Search highlights timed out", logFields);
  } else {
    logger.debug("Search highlights applied", logFields);
  }

  return { attempted, indexHits, replaced, timedOut };
}
