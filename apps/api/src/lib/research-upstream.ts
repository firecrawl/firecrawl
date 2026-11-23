import { Agent, fetch, type Response } from "undici";
import { config } from "../config";
import { logger } from "./logger";

const TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;

const dispatcher = new Agent({
  connectTimeout: CONNECT_TIMEOUT_MS,
});

function appendQuery(
  url: URL,
  params: Record<string, unknown>,
  allowed: string[],
) {
  for (const key of allowed) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          url.searchParams.append(key, String(item));
        }
      }
    } else if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  }
}

export async function fetchResearchUpstream(options: {
  path: string;
  params: Record<string, unknown>;
  queryKeys: string[];
  headers: Record<string, string>;
  timeoutMs?: number;
}) {
  const base = config.RESEARCH_PROXY_URL;
  if (!base) return null;

  const url = new URL(base.replace(/\/+$/, "") + options.path);
  appendQuery(url, options.params, options.queryKeys);

  return fetch(url, {
    method: "GET",
    headers: options.headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    dispatcher,
  });
}

/** An upstream's refusal of a US-only request, relayed to the caller with its status. */
export class UsOnlyUpstreamRefusalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function usOnlyUpstreamRefusal(
  upstream: Response,
  fallback: string,
): Promise<UsOnlyUpstreamRefusalError> {
  const body: any = await upstream.json().catch(() => null);
  const message = [body?.detail, body?.error, body?.message, body?.title].find(
    value => typeof value === "string" && value.length > 0,
  );
  return new UsOnlyUpstreamRefusalError(upstream.status, message ?? fallback);
}

/** The warning for the parts an upstream skipped for a US-only request, if it skipped any. */
export function usOnlySkippedWarning(headers: {
  get(name: string): string | null;
}): string | undefined {
  const skipped = (headers.get("firecrawl-us-only-skipped") ?? "")
    .split(",")
    .map(part => part.trim())
    .filter(part => /^[\w-]+$/.test(part));
  return skipped.length > 0
    ? `Some results were not available under US-only processing: ${skipped.join(", ")}.`
    : undefined;
}

/** POSTs a JSON body to the search platform, or returns null when none is configured. */
async function postSearchPlatform(
  path: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  base = config.SEARCH_PLATFORM_URL,
) {
  if (!base) return null;

  return fetch(base.replace(/\/+$/, "") + path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher,
  });
}

/** The search platform's routing decision for one query. */
export async function fetchQueryFeatures(options: {
  query: string;
  headers: Record<string, string>;
  timeoutMs: number;
}) {
  return postSearchPlatform(
    "/api/v1/query-features",
    { queries: [options.query], features: ["vertical"] },
    options.headers,
    options.timeoutMs,
  );
}

export async function fetchGovUpstream(options: {
  query: string;
  k?: number;
  jurisdiction?: string;
  court?: string;
  courtType?: string;
  cites?: string | string[];
  domain?: string;
  sources?: ("web" | "gov")[];
  headers: Record<string, string>;
  timeoutMs: number;
}) {
  const payload = {
    query: options.query,
    top_k: options.k,
    jurisdiction: options.jurisdiction,
    court: options.court,
    court_type: options.courtType,
    cites: options.cites,
    domain: options.domain,
    sources: options.sources,
  };

  if (!config.GOV_SEARCH_VIA_RESEARCH_PROXY) {
    return postSearchPlatform(
      "/api/v1/gov-search",
      payload,
      options.headers,
      options.timeoutMs,
    );
  }

  const fallbackBase =
    config.SEARCH_PLATFORM_URL &&
    config.SEARCH_PLATFORM_URL !== config.RESEARCH_PROXY_URL
      ? config.SEARCH_PLATFORM_URL
      : undefined;
  const primaryTimeoutMs = fallbackBase
    ? Math.min(options.timeoutMs, Math.max(3_000, Math.floor(options.timeoutMs * 0.6)))
    : options.timeoutMs;
  const startedAt = Date.now();

  try {
    const res = await postSearchPlatform(
      "/api/v1/gov-search",
      payload,
      options.headers,
      primaryTimeoutMs,
      config.RESEARCH_PROXY_URL,
    );
    if (!fallbackBase || (res && res.status !== 429 && res.status < 500)) {
      return res;
    }
    logger.warn("gov research proxy returned retryable status; falling back", {
      module: "research-upstream",
      status: res?.status,
    });
    res?.body?.cancel().catch(() => {});
  } catch (err) {
    if (!fallbackBase) throw err;
    logger.warn("gov research proxy request failed; falling back", {
      module: "research-upstream",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const remainingMs = Math.max(1, options.timeoutMs - (Date.now() - startedAt));
  return postSearchPlatform(
    "/api/v1/gov-search",
    payload,
    options.headers,
    remainingMs,
    fallbackBase,
  );
}

/** The search platform's answer to a plain web search routed to it. */
export async function fetchWebSearchUpstream(options: {
  query: string;
  k: number;
  headers: Record<string, string>;
  timeoutMs: number;
}) {
  return postSearchPlatform(
    "/api/v1/web-search",
    { query: options.query, top_k: options.k },
    options.headers,
    options.timeoutMs,
  );
}
