import { Agent, fetch } from "undici";
import { config } from "../config";

const TIMEOUT_MS = 120_000;

const dispatcher = new Agent({
  connectTimeout: TIMEOUT_MS,
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS,
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
