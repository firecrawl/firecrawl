import { Agent, fetch, type Response } from "undici";
import { config } from "../config";

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

export async function fetchGovUpstream(options: {
  query: string;
  k?: number;
  jurisdiction?: string;
  court?: string;
  courtType?: string;
  cites?: string;
  domain?: string;
  headers: Record<string, string>;
  timeoutMs: number;
}) {
  const base = config.SEARCH_PLATFORM_URL;
  if (!base) return null;

  return fetch(base.replace(/\/+$/, "") + "/api/v1/gov-search", {
    method: "POST",
    headers: { ...options.headers, "content-type": "application/json" },
    body: JSON.stringify({
      query: options.query,
      top_k: options.k,
      jurisdiction: options.jurisdiction,
      court: options.court,
      court_type: options.courtType,
      cites: options.cites,
      domain: options.domain,
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
    dispatcher,
  });
}
