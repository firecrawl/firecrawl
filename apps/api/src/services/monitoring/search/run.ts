import type { Logger } from "winston";
import { search } from "../../../search/v2";
import { buildSearchQuery } from "../../../lib/search-query-builder";
import { hashMonitorUrl } from "../store";
import { canonicalizeUrl, stableSerpFingerprint } from "./dedupe";
import {
  buildJudgePrompt,
  parseVerdict,
  verdictToDecision,
  windowToMs,
  type SearchVerdict,
} from "./judge";
import { hasLlmProvider } from "./tuning";
import {
  searchCreditsForResultCount,
  judgeCreditsForJudgedCount,
} from "./billing";

// Shared dedup decision so the pre-scrape pass and per-result loop never disagree.
function evaluateSerpCandidate(
  c: { url: string; title: string; description: string },
  knownPages: Map<string, KnownPage>,
  goalVersion: string,
  recheckMs: number | undefined,
): {
  canonical: string;
  fingerprint: string;
  knownCurrent: KnownPage | undefined;
  isNewOrChanged: boolean;
} {
  const canonical = canonicalizeUrl(c.url);
  const fingerprint = stableSerpFingerprint({
    url: c.url,
    title: c.title,
    snippet: c.description,
  });
  const known = knownPages.get(canonical);
  const knownCurrent =
    known && known.goalVersion === goalVersion ? known : undefined;
  const isLive =
    knownCurrent?.lastStatus === "alert" ||
    knownCurrent?.lastStatus === "watching";
  const dueForRecheck = Boolean(
    recheckMs &&
      isLive &&
      knownCurrent?.lastCheckedAt &&
      Date.now() - Date.parse(knownCurrent.lastCheckedAt) > recheckMs,
  );
  // A prior transient scrape failure (timeout / anti-bot / budget-exceeded) persists
  // the URL as "skipped". Without this, reuse would re-emit "skipped" forever and the
  // result is never re-scraped or re-judged — a real alert silently lost. Retry it.
  const wasSkipped = knownCurrent?.lastStatus === "skipped";
  const isNewOrChanged =
    !knownCurrent ||
    knownCurrent.fingerprint !== fingerprint ||
    dueForRecheck ||
    wasSkipped;
  return { canonical, fingerprint, knownCurrent, isNewOrChanged };
}

function windowToTbs(window: string): string {
  if (window === "5m" || window === "15m" || window === "1h") return "qdr:h";
  if (window === "6h" || window === "24h") return "qdr:d";
  return "qdr:w";
}

// Empty SERPs are usually genuine "no results", not transient — hedge with a couple
// of quick retries, but don't burn long backoff on queries that simply have no matches.
const SEARCH_EMPTY_RETRY_BACKOFF_MS = [500, 1000] as const;

// Wall-clock budget per run; if the pre-scrape blows past it, remaining candidates
// fall through as skipped/degraded. Kept under the 10-min stale timeout so a run
// always returns before the reaper.
const SEARCH_RUN_BUDGET_MS = 4 * 60 * 1000;

// Deep-mode scrapes run inline (skipNuq), so NuQ concurrency doesn't bound them; cap
// the fan-out ourselves so one maxResults=50 check can't starve the search consumer.
const SEARCH_SCRAPE_CONCURRENCY = 6;

// Never rejects: fn is expected to swallow its own errors into a shared cache.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(pool);
}

// Resolves true if the deadline hits first, false if the work finishes. Never
// rejects; the underlying work keeps running and populates its cache.
async function raceDeadline(
  work: Promise<unknown>,
  budgetMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), Math.max(0, budgetMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  return timedOut;
}

async function searchWithRetry(
  args: Parameters<typeof search>[0],
  logger: Logger,
): Promise<Awaited<ReturnType<typeof search>>> {
  const maxAttempts = SEARCH_EMPTY_RETRY_BACKOFF_MS.length + 1;
  let lastResponse: Awaited<ReturnType<typeof search>> = {};

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await search(args);
    lastResponse = response;

    const hasResults = (response.web?.length ?? 0) > 0;
    if (hasResults) return response;

    const isLastAttempt = attempt === maxAttempts - 1;
    if (!isLastAttempt) {
      const base = SEARCH_EMPTY_RETRY_BACKOFF_MS[attempt];
      const jitter = Math.floor(Math.random() * 250);
      logger.info("search monitor query empty; retrying", {
        query: args.query,
        attempt: attempt + 1,
        backoffMs: base + jitter,
      });
      await new Promise(r => setTimeout(r, base + jitter));
      continue;
    }
  }

  return lastResponse;
}

function isExcludedDomain(
  url: string,
  excludeDomains: string[] | undefined,
): boolean {
  if (!excludeDomains?.length) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return excludeDomains.some(domain => {
    const normalized = domain
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
    return (
      normalized.length > 0 &&
      (host === normalized || host.endsWith(`.${normalized}`))
    );
  });
}

type SearchTargetInput = {
  id: string;
  queries: string[];
  searchWindow: string;
  alertMode: "first_match" | "every_new_result" | "material_dev";
  includeDomains?: string[];
  excludeDomains?: string[];
  recheckAfter?: string;
  maxResults: number;
  depth?: "raw" | "standard" | "deep";
};

export type KnownPage = {
  fingerprint: string;
  goalVersion: string;
  lastCheckedAt?: string;
  lastStatus?: string;
  metadata?: Record<string, unknown>;
};

export type KnownEvent = {
  key: string;
  label: string;
  satisfiedAt?: string;
  alertCount?: number;
};

// Injected by the caller so this module stays free of worker/queue dependencies.
export type ScrapeSearchResult = {
  json: unknown;
  markdown: string;
  metadata: { publishedTime?: string | null; modifiedTime?: string | null };
};

type ScrapeSearchPage = (args: {
  url: string;
  judgePrompt: string;
}) => Promise<ScrapeSearchResult | null>;

type SearchSource = {
  url: string;
  title: string;
  status: "alert" | "already_seen" | "watching" | "ignored" | "skipped";
  alertAction?: string;
  concept?: string;
  eventKey?: string;
  rationale?: string;
};

type SearchTargetRunResult = {
  targetId: string;
  type: "search";
  resultCount: number;
  pagesChecked: number;
  skipped: number;
  meaningful: number;
  matches: number;
  summary: string;
  judgeDegraded: boolean;
  degradedReason: string | null;
  // partialScrapeLoss is a soft signal (distinct from judgeDegraded): some results
  // judged, but most scrapes failed — usable but likely missed developments.
  scrapeFailures: number;
  partialScrapeLoss: boolean;
  sources: SearchSource[];
  searchCredits: number;
  judgeCredits: number;
  resultsJudged: number;
  pageUpserts: Array<{
    url: string;
    urlHash: Buffer;
    status: string;
    scraped?: boolean;
    metadata: Record<string, unknown>;
    judgment?: {
      meaningful: boolean;
      confidence: "high" | "medium" | "low";
      reason: string;
      meaningfulChanges: [];
    };
  }>;
};

function judgmentFromSearchVerdict(
  verdict: SearchVerdict,
  meaningful: boolean,
): NonNullable<SearchTargetRunResult["pageUpserts"][number]["judgment"]> {
  return {
    meaningful,
    confidence: "high",
    reason: verdict.rationale,
    meaningfulChanges: [],
  };
}

export async function runSearchTarget(params: {
  monitor: {
    id: string;
    teamId: string;
    goal: string | null;
    subject: string;
    judgeEnabled: boolean;
  };
  target: SearchTargetInput;
  monitorCheckId: string;
  scrapePage: ScrapeSearchPage;
  // Injected blocklist predicate (keeps this module free of worker/auth deps).
  // Blocked URLs are dropped before scrape/judge/billing. Defaults to allow-all.
  isBlocked?: (url: string) => boolean;
  goalVersion: string;
  knownPages: Map<string, KnownPage>;
  knownEvents: KnownEvent[];
  zeroDataRetention: boolean;
  logger: Logger;
}): Promise<SearchTargetRunResult> {
  const { target, knownPages, goalVersion, logger } = params;
  const isBlocked = params.isBlocked ?? (() => false);
  const judgeEnabled = params.monitor.judgeEnabled;
  const runStart = Date.now();

  const goal = params.monitor.goal?.trim();
  if (judgeEnabled && !goal) {
    throw new Error("search monitor target requires a non-empty monitor goal");
  }
  const subject = params.monitor.subject ?? "";

  const tbs = windowToTbs(target.searchWindow);
  const events: KnownEvent[] = [...params.knownEvents];
  const satisfied = new Set(events.map(e => e.key));
  const sources: SearchSource[] = [];
  const pageUpserts: SearchTargetRunResult["pageUpserts"] = [];
  let resultCount = 0;
  let pagesChecked = 0;
  let skipped = 0;
  let matches = 0;
  let searchResultsBilled = 0;
  let blocked = 0;
  let resultsJudged = 0;
  let judgeScrapeFailures = 0;

  const seenThisRun = new Map<string, number>();
  const candidates: Array<{
    url: string;
    title: string;
    description: string;
    query: string;
    matchedQueries: string[];
  }> = [];
  for (const query of target.queries) {
    const { query: scopedQuery } = buildSearchQuery(query, undefined, {
      includeDomains: target.includeDomains,
      excludeDomains: target.excludeDomains,
    });
    const response = await searchWithRetry(
      {
        query: scopedQuery,
        logger,
        num_results: target.maxResults,
        tbs,
      },
      logger,
    );
    const results = response.web ?? [];
    searchResultsBilled += results.length;
    for (const r of results) {
      if (!r.url) continue;
      if (isExcludedDomain(r.url, target.excludeDomains)) continue;
      if (isBlocked(r.url)) {
        blocked += 1;
        continue;
      }
      const canonical = canonicalizeUrl(r.url);
      const existingIdx = seenThisRun.get(canonical);
      if (existingIdx !== undefined) {
        const existing = candidates[existingIdx];
        if (!existing.matchedQueries.includes(query)) {
          existing.matchedQueries.push(query);
        }
        continue;
      }
      seenThisRun.set(canonical, candidates.length);
      candidates.push({
        url: r.url,
        title: r.title,
        description: r.description,
        query,
        matchedQueries: [query],
      });
    }
  }
  resultCount = candidates.length;

  if (blocked > 0) {
    logger.info("search monitor: dropped blocklisted results before judging", {
      blocked,
      kept: resultCount,
    });
  }

  // An empty retrieval is indistinguishable from "nothing matched"; log to diagnose.
  if (resultCount === 0) {
    logger.warn(
      "search monitor: all queries returned no results after retries",
      {
        queries: target.queries,
        searchWindow: target.searchWindow,
        includeDomains: target.includeDomains,
      },
    );
  }

  const llmStagesAvailable = hasLlmProvider();
  // raw (no LLM) or deep (per-page scrape + verdict); the former "standard" path was removed.
  const depth: "raw" | "deep" =
    !judgeEnabled || target.depth === "raw" ? "raw" : "deep";

  const judgeGoal: string = goal ?? "";

  const selected = candidates.slice(0, target.maxResults);

  const recheckMs = target.recheckAfter ? windowToMs(target.recheckAfter) : 0;

  // Pre-scrape deep-mode pages (bounded concurrency) into a cache so the loop isn't
  // a serial scrape→judge chain. Only the I/O is parallel; dedup/event state stays
  // in the single-threaded loop.
  const deepDocs = new Map<
    string,
    { doc: ScrapeSearchResult | null; error?: unknown }
  >();
  // If the pre-scrape exceeds the run budget, uncached candidates are treated as
  // scrape failures rather than inline-scraped, so the loop returns promptly.
  let budgetExceeded = false;
  if (depth === "deep" && llmStagesAvailable) {
    const judgePrompt = buildJudgePrompt(
      judgeGoal,
      subject,
      target.searchWindow,
    );
    const toScrape = selected.filter(
      c =>
        evaluateSerpCandidate(c, knownPages, goalVersion, recheckMs)
          .isNewOrChanged,
    );
    const preScrape = mapWithConcurrency(
      toScrape,
      SEARCH_SCRAPE_CONCURRENCY,
      async c => {
        const canonical = canonicalizeUrl(c.url);
        try {
          deepDocs.set(canonical, {
            doc: await params.scrapePage({ url: c.url, judgePrompt }),
          });
        } catch (error) {
          deepDocs.set(canonical, { doc: null, error });
        }
      },
    );
    const remainingBudget = SEARCH_RUN_BUDGET_MS - (Date.now() - runStart);
    budgetExceeded = await raceDeadline(preScrape, remainingBudget);
    if (budgetExceeded) {
      logger.warn(
        "search monitor run exceeded its time budget; finishing with partial scrapes",
        {
          monitorId: params.monitor.id,
          targetId: target.id,
          budgetMs: SEARCH_RUN_BUDGET_MS,
          scraped: deepDocs.size,
        },
      );
    }
  }

  for (const c of selected) {
    const { canonical, fingerprint, knownCurrent, isNewOrChanged } =
      evaluateSerpCandidate(c, knownPages, goalVersion, recheckMs);
    const pushUnevaluatedPage = (error: string) => {
      skipped += 1;
      sources.push({ url: c.url, title: c.title, status: "skipped" });
      pageUpserts.push({
        url: c.url,
        urlHash: hashMonitorUrl(canonical),
        status: "skipped",
        scraped: false,
        metadata: {
          fingerprint,
          goalVersion,
          searchStatus: "skipped",
          matchedQueries: c.matchedQueries,
          judgedThisRun: false,
          error,
        },
      });
    };

    if (!isNewOrChanged) {
      const reusedStatus: SearchSource["status"] =
        knownCurrent?.lastStatus === "alert" ||
        knownCurrent?.lastStatus === "already_seen"
          ? "already_seen"
          : knownCurrent?.lastStatus === "ignored" ||
              knownCurrent?.lastStatus === "skipped"
            ? knownCurrent.lastStatus
            : "watching";
      sources.push({ url: c.url, title: c.title, status: reusedStatus });
      pageUpserts.push({
        url: c.url,
        urlHash: hashMonitorUrl(canonical),
        status: reusedStatus,
        metadata: {
          ...(knownCurrent?.metadata ?? {}),
          fingerprint,
          goalVersion,
          searchStatus: reusedStatus,
          judgedThisRun: false,
        },
      });
      continue;
    }

    if (depth === "raw") {
      const nowIso = new Date().toISOString();
      const rawKey = canonical;
      const alreadyAlerted =
        satisfied.has(rawKey) && target.alertMode !== "every_new_result";
      const rawMeta = {
        fingerprint,
        goalVersion,
        searchStatus: alreadyAlerted ? "already_seen" : "alert",
        eventKey: rawKey,
        eventLabel: c.title || c.url,
        query: c.query,
        matchedQueries: c.matchedQueries,
      };
      if (alreadyAlerted) {
        sources.push({
          url: c.url,
          title: c.title,
          status: "already_seen",
          eventKey: rawKey,
        });
        pageUpserts.push({
          url: c.url,
          urlHash: hashMonitorUrl(canonical),
          status: "already_seen",
          scraped: false,
          metadata: rawMeta,
        });
        continue;
      }
      matches += 1;
      satisfied.add(rawKey);
      const existingEvent = events.find(e => e.key === rawKey);
      const eventSatisfiedAt = existingEvent?.satisfiedAt ?? nowIso;
      const eventAlertCount = (existingEvent?.alertCount ?? 0) + 1;
      if (existingEvent) {
        existingEvent.satisfiedAt = eventSatisfiedAt;
        existingEvent.alertCount = eventAlertCount;
      } else {
        events.unshift({
          key: rawKey,
          label: c.title || c.url,
          satisfiedAt: eventSatisfiedAt,
          alertCount: eventAlertCount,
        });
      }
      sources.push({
        url: c.url,
        title: c.title,
        status: "alert",
        eventKey: rawKey,
      });
      pageUpserts.push({
        url: c.url,
        urlHash: hashMonitorUrl(canonical),
        status: "alert",
        scraped: false,
        metadata: {
          ...rawMeta,
          eventSatisfiedAt,
          eventAlertCount,
          eventLastAlertAt: nowIso,
        },
        // Raw mode runs no judge: surfaced as new results, not evaluated as "meaningful".
      });
      continue;
    }

    let verdict: SearchVerdict | null = null;
    let realDate: string | null = null;
    {
      // Read from the pre-scrape cache; scrape inline only as a fallback.
      let doc: ScrapeSearchResult | null;
      const cached = deepDocs.get(canonical);
      if (cached?.error !== undefined) {
        logger.warn("search monitor scrape threw", {
          url: c.url,
          error: cached.error,
        });
        judgeScrapeFailures += 1;
        pushUnevaluatedPage(
          cached.error instanceof Error ? cached.error.message : "scrape threw",
        );
        continue;
      }
      // Out of budget before caching this page: treat as a scrape failure rather
      // than inline-scraping (which would re-incur the time we just budgeted out of).
      if (!cached && budgetExceeded) {
        judgeScrapeFailures += 1;
        pushUnevaluatedPage("run budget exceeded before scrape");
        continue;
      }
      try {
        doc = cached
          ? cached.doc
          : await params.scrapePage({
              url: c.url,
              judgePrompt: buildJudgePrompt(
                judgeGoal,
                subject,
                target.searchWindow,
              ),
            });
      } catch (error) {
        logger.warn("search monitor scrape threw", { url: c.url, error });
        judgeScrapeFailures += 1;
        pushUnevaluatedPage(
          error instanceof Error ? error.message : "scrape threw",
        );
        continue;
      }

      if (!doc) {
        logger.warn("search monitor scrape failed", { url: c.url });
        judgeScrapeFailures += 1;
        pushUnevaluatedPage("scrape failed");
        continue;
      }
      pagesChecked += 1;

      verdict = parseVerdict(doc.json);
      if (!verdict) {
        judgeScrapeFailures += 1;
        pushUnevaluatedPage("verdict unparseable");
        continue;
      }
      realDate =
        doc.metadata?.publishedTime ?? doc.metadata?.modifiedTime ?? null;
    }

    resultsJudged += 1;

    const decision = verdictToDecision(verdict);
    const meaningfulJudgment = judgmentFromSearchVerdict(
      verdict,
      decision === "notify",
    );

    const baseMeta = {
      fingerprint,
      goalVersion,
      alertAction: verdict.alertAction,
      publishedAt: realDate,
      concept: verdict.concept,
      rationale: verdict.rationale,
      matchedQueries: c.matchedQueries,
      judgedThisRun: true,
    };

    if (decision === "ignore") {
      sources.push({
        url: c.url,
        title: c.title,
        status: "ignored",
        ...baseMeta,
      });
      pageUpserts.push({
        url: c.url,
        urlHash: hashMonitorUrl(canonical),
        status: "ignored",
        scraped: depth === "deep",
        metadata: { ...baseMeta, searchStatus: "ignored" },
        judgment: meaningfulJudgment,
      });
      continue;
    }
    if (decision === "watch") {
      sources.push({
        url: c.url,
        title: c.title,
        status: "watching",
        ...baseMeta,
      });
      pageUpserts.push({
        url: c.url,
        urlHash: hashMonitorUrl(canonical),
        status: "watching",
        scraped: depth === "deep",
        metadata: { ...baseMeta, searchStatus: "watching" },
        judgment: meaningfulJudgment,
      });
      continue;
    }

    // Deterministic event key: dedup by canonical URL (no LLM event resolver).
    const eventKey = canonical;
    const eventLabel = verdict.concept || c.url;

    // Re-alert on every new result only in every_new_result mode; otherwise dedup.
    const alreadySatisfied =
      satisfied.has(eventKey) && target.alertMode !== "every_new_result";
    const eventMeta = { ...baseMeta, eventKey, eventLabel };

    if (alreadySatisfied) {
      sources.push({
        url: c.url,
        title: c.title,
        status: "already_seen",
        eventKey,
        ...baseMeta,
      });
      pageUpserts.push({
        url: c.url,
        urlHash: hashMonitorUrl(canonical),
        status: "already_seen",
        scraped: depth === "deep",
        metadata: { ...eventMeta, searchStatus: "already_seen" },
        judgment: meaningfulJudgment,
      });
      continue;
    }

    matches += 1;
    satisfied.add(eventKey);
    const nowIso = new Date().toISOString();
    const existingEvent = events.find(e => e.key === eventKey);
    const eventSatisfiedAt = existingEvent?.satisfiedAt ?? nowIso;
    const eventAlertCount = (existingEvent?.alertCount ?? 0) + 1;
    if (existingEvent) {
      existingEvent.satisfiedAt = eventSatisfiedAt;
      existingEvent.alertCount = eventAlertCount;
    } else {
      events.unshift({
        key: eventKey,
        label: eventLabel,
        satisfiedAt: eventSatisfiedAt,
        alertCount: eventAlertCount,
      });
    }
    sources.push({
      url: c.url,
      title: c.title,
      status: "alert",
      eventKey,
      ...baseMeta,
    });
    pageUpserts.push({
      url: c.url,
      urlHash: hashMonitorUrl(canonical),
      status: "alert",
      scraped: depth === "deep",
      metadata: {
        ...eventMeta,
        searchStatus: "alert",
        eventSatisfiedAt,
        eventAlertCount,
        eventLastAlertAt: nowIso,
      },
      judgment: meaningfulJudgment,
    });
  }

  const meaningful = sources.filter(
    s => s.status === "alert" || s.status === "already_seen",
  ).length;

  let summary =
    matches > 0
      ? `${matches} match${matches === 1 ? "" : "es"} across ${resultCount} result${resultCount === 1 ? "" : "s"}.`
      : "";

  const judgeDegraded =
    depth === "deep" &&
    candidates.length > 0 &&
    resultsJudged === 0 &&
    judgeScrapeFailures > 0;
  if (judgeDegraded) {
    logger.warn(
      "search monitor run is degraded: results were found but none could be judged; results may be incomplete (NOT a clean no-results)",
      {
        monitorId: params.monitor.id,
        targetId: target.id,
        depth,
        candidates: candidates.length,
        scrapeFailures: judgeScrapeFailures,
        resultsJudged,
      },
    );
    if (!summary) {
      summary =
        "Results were found but could not be evaluated (the judge step failed); this check is incomplete and may have missed new developments.";
    }
  }

  const degradedReason: string | null = judgeDegraded
    ? "results were found but none could be judged; results may be incomplete"
    : null;

  // Soft signal (not judgeDegraded): verdicts produced but most scrapes failed, so
  // it likely missed real developments. Surfaced for observability; doesn't fail the check.
  const partialScrapeLoss =
    resultsJudged > 0 &&
    judgeScrapeFailures > 0 &&
    judgeScrapeFailures / (resultsJudged + judgeScrapeFailures) >= 0.5;
  if (partialScrapeLoss) {
    logger.warn(
      "search monitor run had heavy partial scrape loss: judged some results but most scrapes failed; coverage may be incomplete",
      {
        monitorId: params.monitor.id,
        targetId: target.id,
        resultsJudged,
        scrapeFailures: judgeScrapeFailures,
      },
    );
  }

  const isZDR = params.zeroDataRetention;
  const searchCredits = searchCreditsForResultCount(searchResultsBilled, isZDR);
  const judgeCredits = judgeCreditsForJudgedCount(resultsJudged);

  return {
    targetId: target.id,
    type: "search",
    resultCount,
    pagesChecked,
    skipped,
    meaningful,
    matches,
    summary,
    judgeDegraded,
    degradedReason,
    scrapeFailures: judgeScrapeFailures,
    partialScrapeLoss,
    sources,
    searchCredits,
    judgeCredits,
    resultsJudged,
    pageUpserts,
  };
}
