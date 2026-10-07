/**
 * Facts about a hint-enabled response, computed locally from the response
 * body and request state already in memory. Provider-supplied rules are
 * matched against these values and may reference them as text placeholders;
 * the values themselves never leave the API.
 */
export type AgentHintEndpoint = "search" | "scrape" | "parse" | "map";

export interface AgentHintSignalContext {
  endpoint: AgentHintEndpoint;
  response: unknown;
  remainingCredits?: number;
  canUseMapAndCrawl?: boolean;
  canUseInteract?: boolean;
}

export type AgentHintSignalValue = string | number | boolean | string[];
export type AgentHintSignals = Map<string, AgentHintSignalValue>;

const PDF_MAX_PAGES_LIMIT = 10000;
const HINT_URL_MAX_CHARS = 200;
const QUERY_PATH_SEGMENTS = 2;

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}

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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function setDefined(
  signals: AgentHintSignals,
  name: string,
  value: AgentHintSignalValue | undefined,
): void {
  if (value !== undefined) signals.set(name, value);
}

function addPageSignals(
  signals: AgentHintSignals,
  response: ObjectValue,
  metadata: ObjectValue,
): void {
  if (typeof metadata.statusCode === "number") {
    signals.set("page_status", metadata.statusCode);
  }

  const scrapeId =
    typeof metadata.scrapeId === "string" && metadata.scrapeId
      ? metadata.scrapeId
      : typeof response.scrape_id === "string" && response.scrape_id
        ? response.scrape_id
        : undefined;
  if (scrapeId) signals.set("scrape_id", encodeURIComponent(scrapeId));

  const source = httpUrl(metadata.sourceURL);
  const final = httpUrl(metadata.url);
  if (source && final && source.href !== final.href) {
    const from = quotedUrl(source);
    const to = quotedUrl(final);
    if (from && to) {
      signals.set("page_redirect_from", from);
      signals.set("page_redirect_to", to);
    }
  }
  const page = final ?? source;
  if (page) {
    signals.set("page_host", page.hostname);
    const words = pathWords(page);
    if (words) signals.set("page_path_words", words);
  }

  const returned = finiteNumber(metadata.numPages);
  const total = finiteNumber(metadata.totalPages);
  setDefined(signals, "document_pages_returned", returned);
  setDefined(signals, "document_pages_total", total);
  if (returned !== undefined && total !== undefined) {
    const maxPages = Math.min(total, PDF_MAX_PAGES_LIMIT);
    signals.set("document_max_pages", maxPages);
    signals.set("document_pages_requestable", Math.max(0, maxPages - returned));
  }
}

function addResultSignals(signals: AgentHintSignals, web: unknown[]): void {
  signals.set("result_count", web.length);

  const excerpts: string[] = [];
  const originCounts = new Map<string, number>();
  web.forEach((value, index) => {
    const item = object(value);
    const url = typeof item.url === "string" ? item.url : undefined;
    if (url === undefined) return;
    const parsed = httpUrl(url);
    if (
      item.markdown === undefined &&
      item.html === undefined &&
      item.rawHtml === undefined
    ) {
      const quoted = parsed ? quotedUrl(parsed) : undefined;
      const position = resultPosition(item, index);
      excerpts.push(quoted ? `#${position} ${quoted}` : `#${position}`);
    }
    if (parsed) {
      originCounts.set(
        parsed.origin,
        (originCounts.get(parsed.origin) ?? 0) + 1,
      );
    }
  });

  signals.set("excerpt_count", excerpts.length);
  signals.set("excerpt_results", excerpts);
  if (web.length > 0) {
    signals.set("excerpt_share", excerpts.length / web.length);
  }

  const originResults = [...originCounts.values()].reduce(
    (total, count) => total + count,
    0,
  );
  signals.set("origin_result_count", originResults);
  const top = [...originCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) {
    signals.set("top_origin", top[0]);
    signals.set("top_origin_count", top[1]);
    signals.set("top_origin_share", top[1] / originResults);
  }
}

export function computeAgentHintSignals(
  context: AgentHintSignalContext,
): AgentHintSignals {
  const response = object(context.response);
  const data = object(response.data);
  const signals: AgentHintSignals = new Map();

  signals.set("endpoint", context.endpoint);
  signals.set("success", response.success === true);
  signals.set("can_use_map_and_crawl", context.canUseMapAndCrawl === true);
  signals.set("can_use_interact", context.canUseInteract === true);
  setDefined(
    signals,
    "remaining_credits",
    finiteNumber(context.remainingCredits),
  );

  addPageSignals(signals, response, object(data.metadata));

  const web = Array.isArray(response.data)
    ? response.data
    : Array.isArray(data.web)
      ? data.web
      : undefined;
  if (web) addResultSignals(signals, web);

  return signals;
}
