import type { Logger } from "winston";
import type { WebSearchResult } from "../lib/entities";
import { config } from "../config";
import {
  fetchGovUpstream,
  fetchQueryFeatures,
  fetchWebSearchUpstream,
  usOnlySkippedWarning,
  usOnlyUpstreamRefusal,
  UsOnlyUpstreamRefusalError,
} from "../lib/research-upstream";
import { logger as rootLogger } from "../lib/logger";
import { hasCategory, type CategoryOption } from "../lib/search-query-builder";

/**
 * The longest a routed search waits for the search platform before falling
 * back to the regular web search, which starts only then.
 */
const ROUTED_SEARCH_TIMEOUT_MS = 4000;

/**
 * The largest page a search may ask for and still be routed. A routed answer
 * may hold no more than this many results, so a larger page stays on the
 * regular web search.
 */
export const MAX_ROUTED_LIMIT = 10;

/**
 * After this many failures in a row of one search platform call, this process
 * stops routing for PAUSE_MS. An outage then delays a handful of searches per
 * process instead of every routed search until routing is switched off.
 */
const PAUSE_AFTER_FAILURES = 5;
const PAUSE_MS = 60_000;

/**
 * Failures in a row of each search platform call on this process. Only a call's
 * own answer resets its count: a decision that routes nothing says nothing
 * about the web search.
 */
const failuresInARow = { decision: 0, webSearch: 0 };
let pausedUntil = 0;

/**
 * What one search platform call says about the platform's health. A refusal
 * of the query (a 4xx) or a call cut short by the request's own deadline says
 * nothing either way, so no caller can pause routing for every team on the
 * process.
 */
type PlatformHealth = "answered" | "failed" | "unknown";

type GovSearchOptions = Parameters<typeof searchGovCategory>[0];

/** What happened to one plain web search's routing; logged once per search. */
type RoutingOutcome =
  | "paused"
  | "decision_failed"
  | "not_routed"
  | "routed_failed"
  | "routed_empty"
  | "routed_served";

export function wantsGovCategory(categories?: CategoryOption[]): boolean {
  return hasCategory(categories, "gov");
}

export async function searchGovCategory(
  options: {
    query: string;
    limit: number;
    teamId: string;
    timeout: number;
    zeroDataRetention: boolean;
    usOnly?: boolean;
    /** Receives the warnings for parts the upstream skipped for a US-only request. */
    warnings?: string[];
  },
  logger: Logger,
): Promise<WebSearchResult[]> {
  try {
    const upstream = await fetchGovUpstream({
      query: options.query,
      k: options.limit,
      headers: {
        "firecrawl-team-id": options.teamId,
        "firecrawl-zero-data-retention": String(options.zeroDataRetention),
        ...(options.usOnly ? { "firecrawl-us-only": "true" } : {}),
      },
      timeoutMs: options.timeout,
    });
    if (upstream === null) {
      return [];
    }
    if (options.usOnly && upstream.status >= 400 && upstream.status < 500) {
      throw await usOnlyUpstreamRefusal(
        upstream,
        "Government search refused the request.",
      );
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      logger.warn("Gov category upstream failed", { status: upstream.status });
      return [];
    }

    const skipped = options.usOnly
      ? usOnlySkippedWarning(upstream.headers)
      : undefined;
    if (skipped) options.warnings?.push(skipped);

    return platformResults(await upstream.json(), options.limit).map(
      result => ({ ...result, category: "gov" }),
    );
  } catch (error) {
    if (error instanceof UsOnlyUpstreamRefusalError) throw error;
    logger.warn("Gov category upstream error", { error });
    return [];
  }
}

/**
 * The search platform's results for a plain web search that it classifies as
 * government, or null when the search stays on the regular web search: routing
 * is off or paused, the decision failed or did not route the query, or the
 * routed search failed or found nothing. An answer with fewer results than
 * asked is served as it is, as a short page of regular web results is.
 *
 * Routing spends the request's own `timeout`, and leaves at least half of it to
 * the regular web search when the route fails.
 *
 * Every search that reaches the routing decision logs one `search_gov_routing`
 * line with its outcome.
 */
export async function searchGovIfRouted(
  options: GovSearchOptions,
  searchId: string,
  logger: Logger,
): Promise<WebSearchResult[] | null> {
  if (!config.GOV_ROUTING_ENABLED) return null;
  const deadline = Date.now() + options.timeout;

  const record = (
    outcome: RoutingOutcome,
    measured: { decisionMs?: number; webSearchMs?: number; results?: number },
  ) =>
    // Root logger: the request logger carries the query, and this line records shape only.
    rootLogger.info("Search gov routing", {
      event: "search_gov_routing",
      searchId,
      teamId: options.teamId,
      outcome,
      limit: options.limit,
      ...measured,
    });

  if (Date.now() < pausedUntil) {
    record("paused", {});
    return null;
  }

  const decisionStarted = Date.now();
  const decision = await searchCategoriesRouted(options, deadline, logger);
  const decisionMs = Date.now() - decisionStarted;
  countCall("decision", decision.health);
  if (decision.categories === null) {
    record("decision_failed", { decisionMs });
    return null;
  }
  if (!decision.categories.includes("GOVERNMENT")) {
    record("not_routed", { decisionMs });
    return null;
  }
  // Routing may have paused while this decision was in flight.
  if (Date.now() < pausedUntil) {
    record("paused", { decisionMs });
    return null;
  }

  const webSearchStarted = Date.now();
  const routed = await searchRoutedWeb(options, deadline, logger);
  const webSearchMs = Date.now() - webSearchStarted;
  countCall("webSearch", routed.health);
  if (routed.results === null) {
    record("routed_failed", { decisionMs, webSearchMs });
    return null;
  }
  if (routed.results.length === 0) {
    record("routed_empty", { decisionMs, webSearchMs, results: 0 });
    return null;
  }
  record("routed_served", {
    decisionMs,
    webSearchMs,
    results: routed.results.length,
  });
  return routed.results;
}

/**
 * Counts what a search platform call said about the platform's health, and
 * pauses routing on this process once one call has failed
 * PAUSE_AFTER_FAILURES times in a row.
 */
function countCall(
  call: keyof typeof failuresInARow,
  health: PlatformHealth,
): void {
  if (health === "unknown") return;
  if (health === "answered") {
    failuresInARow[call] = 0;
    return;
  }
  failuresInARow[call] += 1;
  if (failuresInARow[call] < PAUSE_AFTER_FAILURES) return;
  failuresInARow.decision = 0;
  failuresInARow.webSearch = 0;
  pausedUntil = Date.now() + PAUSE_MS;
  rootLogger.warn(
    "Gov routing paused after repeated search platform failures",
    {
      call,
      failuresInARow: PAUSE_AFTER_FAILURES,
      pauseMs: PAUSE_MS,
    },
  );
}

/**
 * How long a routing call may take: its own limit, or half the time left
 * before the request's deadline when that is shorter, so a failed route
 * leaves the regular web search at least as long as the route took.
 * `deadlineBound` is true when the deadline, not the limit, set the time.
 */
function routingTimeout(limitMs: number, deadline: number) {
  const halfLeft = Math.max(0, Math.floor((deadline - Date.now()) / 2));
  return halfLeft < limitMs
    ? { timeoutMs: halfLeft, deadlineBound: true }
    : { timeoutMs: limitMs, deadlineBound: false };
}

/**
 * The search platform's web search for a routed query, with null results when
 * the request failed, timed out, or was answered with a status other than 2xx
 * or a body without a `data.web` list. It asks for twice the page, as the
 * regular web search does, so results that safe search or threat protection
 * remove still leave a full page. Its results are served as web results, so
 * they carry no gov category.
 */
async function searchRoutedWeb(
  options: GovSearchOptions,
  deadline: number,
  logger: Logger,
): Promise<{ results: WebSearchResult[] | null; health: PlatformHealth }> {
  const { timeoutMs, deadlineBound } = routingTimeout(
    ROUTED_SEARCH_TIMEOUT_MS,
    deadline,
  );
  const k = options.limit * 2;
  try {
    const upstream = await fetchWebSearchUpstream({
      query: options.query,
      k,
      headers: {
        "firecrawl-team-id": options.teamId,
        "firecrawl-zero-data-retention": String(options.zeroDataRetention),
      },
      timeoutMs,
    });
    if (upstream === null) return { results: null, health: "failed" };
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      logger.warn("Routed web search upstream failed", {
        status: upstream.status,
      });
      return {
        results: null,
        health:
          upstream.status >= 400 && upstream.status < 500
            ? "unknown"
            : "failed",
      };
    }
    const body: any = await upstream.json();
    if (!Array.isArray(body?.data?.web)) {
      logger.warn("Routed web search answered without data.web");
      return { results: null, health: "failed" };
    }
    return { results: platformResults(body, k), health: "answered" };
  } catch (error) {
    logger.warn("Routed web search upstream error", { error });
    return {
      results: null,
      health:
        deadlineBound && error?.name === "TimeoutError" ? "unknown" : "failed",
    };
  }
}

/** The `data.web` results of a search platform answer, renumbered from 1. */
function platformResults(body: any, limit: number): WebSearchResult[] {
  const results: any[] = Array.isArray(body?.data?.web) ? body.data.web : [];
  return results
    .slice(0, limit)
    .map((result, index) => ({
      url: typeof result?.url === "string" ? result.url : "",
      title:
        typeof result?.title === "string" && result.title.trim().length > 0
          ? result.title
          : typeof result?.url === "string"
            ? result.url
            : "",
      description:
        typeof result?.description === "string" ? result.description : "",
      position: index + 1,
    }))
    .filter(result => result.url.length > 0);
}

/**
 * The categories the search platform routes the query to, null when the call
 * failed, timed out, or answered without a list of category names.
 */
async function searchCategoriesRouted(
  options: GovSearchOptions,
  deadline: number,
  logger: Logger,
): Promise<{ categories: string[] | null; health: PlatformHealth }> {
  const { timeoutMs, deadlineBound } = routingTimeout(
    config.GOV_ROUTING_DECISION_TIMEOUT_MS,
    deadline,
  );
  try {
    const upstream = await fetchQueryFeatures({
      query: options.query,
      headers: {
        "firecrawl-zero-data-retention": String(options.zeroDataRetention),
      },
      timeoutMs,
    });
    if (upstream === null) return { categories: null, health: "failed" };
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      logger.warn("Routing decision upstream failed", {
        status: upstream.status,
      });
      return {
        categories: null,
        health:
          upstream.status >= 400 && upstream.status < 500
            ? "unknown"
            : "failed",
      };
    }
    const body: any = await upstream.json();
    const routed = body?.results?.[0]?.vertical?.search_category_routed;
    if (
      !Array.isArray(routed) ||
      !routed.every(category => typeof category === "string")
    ) {
      logger.warn("Routing decision answered without search_category_routed");
      return { categories: null, health: "failed" };
    }
    return { categories: routed, health: "answered" };
  } catch (error) {
    logger.warn("Routing decision upstream error", { error });
    return {
      categories: null,
      health:
        deadlineBound && error?.name === "TimeoutError" ? "unknown" : "failed",
    };
  }
}
