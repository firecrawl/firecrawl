/** Deterministic guidance from state already available on the request path. */
export type AgentHintEndpoint = "search" | "scrape" | "parse" | "map";
export interface AgentHintContext {
  endpoint: AgentHintEndpoint;
  response: unknown;
  remainingCredits?: number;
}

export const AGENT_HINT_LOW_CREDIT_THRESHOLD = 100;
const SEARCH_CLUSTER_MIN_RESULTS = 4;
const SEARCH_CLUSTER_MIN_ORIGIN_RESULTS = 3;
const SEARCH_CLUSTER_MIN_SHARE = 0.75;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function clusteredOrigin(web: unknown[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of web) {
    const url = object(value).url;
    if (typeof url !== "string") continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue;
      }
      const origin = parsed.origin;
      counts.set(origin, (counts.get(origin) ?? 0) + 1);
    } catch {
      // Ignore malformed result URLs rather than allowing them to fire a hint.
    }
  }
  const validResults = [...counts.values()].reduce(
    (total, count) => total + count,
    0,
  );
  if (validResults < SEARCH_CLUSTER_MIN_RESULTS) return undefined;
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return dominant &&
    dominant[1] >= SEARCH_CLUSTER_MIN_ORIGIN_RESULTS &&
    dominant[1] / validResults >= SEARCH_CLUSTER_MIN_SHARE
    ? dominant[0]
    : undefined;
}
export function buildAgentHints(context: AgentHintContext): string[] {
  const response = object(context.response);
  const data = object(response.data);
  let nextAction: string | undefined;
  if (response.success === true) {
    const metadata = object(data.metadata);
    const pageStatus = metadata.statusCode;
    if (context.endpoint === "scrape" && pageStatus === 401) {
      const scrapeId =
        typeof metadata.scrapeId === "string" && metadata.scrapeId
          ? metadata.scrapeId
          : typeof response.scrape_id === "string" && response.scrape_id
            ? response.scrape_id
            : undefined;
      if (scrapeId) {
        nextAction = `The source page returned 401 and this scrape can continue interactively. If access requires login or page interaction, use POST /v2/scrape/${encodeURIComponent(scrapeId)}/interact with {"prompt":"<next browser action>"}.`;
      }
    } else if (
      context.endpoint === "scrape" &&
      (pageStatus === 404 || pageStatus === 410)
    ) {
      nextAction =
        'The source page returned 404 or 410. If you need its current location or an alternative, use POST /v2/search with {"query":"<page name or subject>","sources":["web"]}. Use the page identity from your task; this is not a transient-error retry.';
    } else if (
      context.endpoint === "scrape" &&
      typeof metadata.numPages === "number" &&
      Number.isFinite(metadata.numPages) &&
      typeof metadata.totalPages === "number" &&
      Number.isFinite(metadata.totalPages) &&
      metadata.totalPages > metadata.numPages
    ) {
      const maxPages = Math.min(metadata.totalPages, 10000);
      nextAction = `This document returned ${metadata.numPages} of ${metadata.totalPages} pages. If you need more pages, repeat POST /v2/scrape for the same URL with {"parsers":[{"type":"pdf","maxPages":${maxPages}}]}.`;
    } else if (context.endpoint === "search") {
      const web = Array.isArray(response.data)
        ? response.data
        : Array.isArray(data.web)
          ? data.web
          : undefined;
      if (web?.length === 0) {
        nextAction =
          'No web results were returned. If the task is still unresolved, use POST /v2/search again with {"query":"<broader or alternative query>","sources":["web"]}.';
      } else if (web) {
        const hasMissingContent = web.some(value => {
          const item = object(value);
          return (
            typeof item.url === "string" &&
            !item.markdown &&
            !item.html &&
            !item.rawHtml
          );
        });
        if (hasMissingContent) {
          nextAction =
            'Some web results have no full page content. If you need more than an excerpt, use POST /v2/scrape with {"url":"<selected result URL>","formats":["markdown"]}. Retrieve only needed pages; do not re-scrape results that already contain the required content.';
        } else {
          const origin = clusteredOrigin(web);
          if (origin) {
            nextAction = `Most web results come from ${origin}. If you need broader coverage of that site, use POST /v2/map with {"url":"${origin}"} to discover URLs, or POST /v2/crawl with {"url":"${origin}"} to retrieve content across pages.`;
          }
        }
      }
    }
  }

  const lowCredits =
    typeof context.remainingCredits === "number" &&
    Number.isFinite(context.remainingCredits) &&
    context.remainingCredits < AGENT_HINT_LOW_CREDIT_THRESHOLD
      ? "The connected Firecrawl account is low on credits. Let the user know they should add more credits."
      : undefined;

  return [nextAction, lowCredits]
    .filter((hint): hint is string => !!hint)
    .filter((hint, index, hints) => hints.indexOf(hint) === index);
}
