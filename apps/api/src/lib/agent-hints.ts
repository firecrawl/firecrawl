/** Deterministic guidance from state already available on the request path. */
export type AgentHintEndpoint = "search" | "scrape" | "parse" | "map";
export interface AgentHintContext {
  endpoint: AgentHintEndpoint;
  response: unknown;
  remainingCredits?: number;
  canUseMapAndCrawl?: boolean;
  canUseInteract?: boolean;
}

const AGENT_HINT_LOW_CREDIT_THRESHOLD = 100;
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
const EXCERPT_URLS_SHOWN = 3;

const QUERY_PATH_SEGMENTS = 2;

function httpUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

const HINT_URL_MAX_CHARS = 200;

/**
 * Result URLs come from third-party pages, so they are rendered only as a
 * parsed http(s) href (whitespace and quotes percent-encoded), length-capped,
 * and JSON-quoted to mark them as data rather than instruction text.
 */
function quotedUrl(url: URL): string | undefined {
  const href = url.href;
  return href.length <= HINT_URL_MAX_CHARS ? JSON.stringify(href) : undefined;
}

function resultPosition(item: ObjectValue, index: number): number {
  const position = item.position;
  return typeof position === "number" &&
    Number.isInteger(position) &&
    position > 0
    ? position
    : index + 1;
}

/** Names the excerpt-only results by their response position so the agent can pick. */
function excerptOnlyHint(web: unknown[]): string | undefined {
  const excerpts: { position: number; url: string | undefined }[] = [];
  web.forEach((value, index) => {
    const item = object(value);
    if (
      typeof item.url === "string" &&
      item.markdown === undefined &&
      item.html === undefined &&
      item.rawHtml === undefined
    ) {
      const parsed = httpUrl(item.url);
      const quoted = parsed ? quotedUrl(parsed) : undefined;
      excerpts.push({
        position: resultPosition(item, index),
        url: quoted,
      });
    }
  });
  if (excerpts.length === 0) return undefined;
  const shown = excerpts.slice(0, EXCERPT_URLS_SHOWN);
  const listed = shown
    .map(e => (e.url ? `#${e.position} ${e.url}` : `#${e.position}`))
    .join(", ");
  const more =
    excerpts.length > shown.length
      ? ` and ${excerpts.length - shown.length} more`
      : "";
  const subject =
    excerpts.length === web.length
      ? `All ${web.length} web results are excerpts only`
      : `${excerpts.length} of ${web.length} web results are excerpts only`;
  return `${subject} (${listed}${more}). If you need more than an excerpt, use firecrawl_scrape with {"url":"<one of these URLs>","formats":["markdown"]}. Retrieve only needed pages; do not re-scrape results that already contain the required content.`;
}

/**
 * Identifier-like path segments carry no searchable meaning: numbers, hex or
 * UUID-style ids, ULIDs, and long mixed alphanumeric tokens such as
 * "W020260806515694454560".
 */
function isOpaqueId(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f-]{16,}$/i.test(segment)) return true;
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(segment)) return true;
  return (
    segment.length >= 12 &&
    /^[A-Za-z0-9_]+$/.test(segment) &&
    (segment.match(/\d/g)?.length ?? 0) >= 4
  );
}

/** Words from the last path segments, e.g. /payments/checkout/migration-from-legacy -> "checkout migration from legacy". */
function pathWords(url: URL): string {
  const segments = url.pathname
    .split("/")
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .map(segment => segment.replace(/\.[a-z0-9]{1,5}$/i, ""))
    .filter(segment => segment && !isOpaqueId(segment));
  return segments
    .slice(-QUERY_PATH_SEGMENTS)
    .join(" ")
    .replace(/[-_+.]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function redirectNote(source: URL, final: URL): string {
  const from = quotedUrl(source);
  const to = quotedUrl(final);
  return from && to ? ` after redirecting from ${from} to ${to}` : "";
}

/** 404/410 guidance built from the requested and final URLs only. */
function goneHint(metadata: ObjectValue, status: number): string {
  const source = httpUrl(metadata.sourceURL);
  const final = httpUrl(metadata.url);
  const page = final ?? source;
  const redirected =
    source && final && source.href !== final.href
      ? redirectNote(source, final)
      : "";
  const words = page ? pathWords(page) : "";
  const query =
    page && words ? `site:${page.hostname} ${words}` : "<page name or subject>";
  return `The source page returned ${status}${redirected}. If you need its current location or an alternative, use firecrawl_search with ${JSON.stringify({ query, sources: ["web"] })}. Adjust the query to the page identity from your task; this is not a transient-error retry.`;
}

export function buildAgentHints(context: AgentHintContext): string[] {
  const response = object(context.response);
  const data = object(response.data);
  let nextAction: string | undefined;
  if (response.success === true) {
    const metadata = object(data.metadata);
    const pageStatus = metadata.statusCode;
    if (
      context.endpoint === "scrape" &&
      pageStatus === 401 &&
      context.canUseInteract
    ) {
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
      nextAction = goneHint(metadata, pageStatus);
    } else if (
      context.endpoint === "scrape" &&
      typeof metadata.numPages === "number" &&
      Number.isFinite(metadata.numPages) &&
      typeof metadata.totalPages === "number" &&
      Number.isFinite(metadata.totalPages) &&
      metadata.totalPages > metadata.numPages
    ) {
      const maxPages = Math.min(metadata.totalPages, 10000);
      if (maxPages > metadata.numPages) {
        nextAction = `This document returned ${metadata.numPages} of ${metadata.totalPages} pages. If you need more pages, repeat firecrawl_scrape for the same URL with {"parsers":[{"type":"pdf","maxPages":${maxPages}}]}.`;
      }
    } else if (context.endpoint === "search") {
      const web = Array.isArray(response.data)
        ? response.data
        : Array.isArray(data.web)
          ? data.web
          : undefined;
      if (web?.length === 0) {
        nextAction = `No web results were returned. If the task is still unresolved, use firecrawl_search again with {"query":"<broader or alternative query>","sources":["web"]}.`;
      } else if (web) {
        const excerptHint = excerptOnlyHint(web);
        if (excerptHint) {
          nextAction = excerptHint;
        } else {
          const origin = context.canUseMapAndCrawl
            ? clusteredOrigin(web)
            : undefined;
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

  return [lowCredits, nextAction]
    .filter((hint): hint is string => !!hint)
    .filter((hint, index, hints) => hints.indexOf(hint) === index);
}
