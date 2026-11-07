import type { Logger } from "winston";
import { config } from "../config";

// Query Highlights model service: given full markdown pages and a query, the
// service returns query-relevant highlights plus each page's highlights
// reassembled into a single markdown document (in document order). All indexed
// search results go through one `/batch_highlight` call. The endpoint is
// URL-config-gated; callers must confirm it is set via highlightsEnvReady()
// before invoking. Bearer auth remains optional for legacy/external services;
// the in-cluster GCP Stage 1 service relies on cluster network isolation.

const REQUEST_TIMEOUT_MS = 30000;
const MAX_BATCH_ATTEMPTS = 2;
const RETRY_DELAY_MS = 50;

export type HighlightFailureReason =
  | "timeout"
  | "network"
  | "http_4xx"
  | "http_5xx"
  | "invalid_response"
  | "unknown";

class HighlightHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`highlight model HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

class HighlightInvalidResponseError extends Error {}

// One highlight entry as returned by the service. Field semantics are
// intentionally left undocumented here.
interface Highlight {
  block_index?: number;
  kind?: string;
  via?: string;
  score?: number;
  span_md?: string;
}

interface HighlightResponse {
  highlights?: Highlight[];
  markdown?: string;
}

interface HighlightBatchPageResponse {
  id?: string;
  output?: HighlightResponse;
}

interface HighlightBatchResponse {
  pages?: HighlightBatchPageResponse[];
}

interface HighlightPage {
  id: string;
  markdown: string;
}

export interface HighlightIndexedPage {
  id: string;
  url: string;
  indexObject: string;
}

// Result for one page in the batch: the service's highlight entries plus the
// reassembled markdown document.
interface HighlightResult {
  highlights: Highlight[];
  markdown: string;
}

function failureReason(error: unknown): HighlightFailureReason {
  if (error instanceof HighlightHttpError) {
    return error.status >= 500 ? "http_5xx" : "http_4xx";
  }
  if (error instanceof SyntaxError) {
    return "invalid_response";
  }
  if (error instanceof HighlightInvalidResponseError) {
    return "invalid_response";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "timeout";
  }
  if (error instanceof TypeError) {
    return "network";
  }
  return "unknown";
}

function waitForRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, RETRY_DELAY_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchBatchWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.status < 500 || attempt === MAX_BATCH_ATTEMPTS) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      lastError = new HighlightHttpError(response.status, "");
    } catch (error) {
      lastError = error;
      if (signal.aborted || attempt === MAX_BATCH_ATTEMPTS) {
        throw error;
      }
    }
    await waitForRetry(signal);
  }
  throw lastError;
}

function requestHeaders(requestId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (requestId) {
    headers["X-Request-ID"] = requestId;
  }
  if (config.HIGHLIGHT_MODEL_TOKEN) {
    headers.Authorization = `Bearer ${config.HIGHLIGHT_MODEL_TOKEN}`;
  }
  return headers;
}

/**
 * Generate query highlights for every indexed result in one request. Results
 * are keyed by the caller-provided page ID so a missing page can fall back to
 * its provider snippet without discarding successful pages. Returns null when
 * the whole call fails.
 */
interface HighlightBatchOptions {
  logger: Logger;
  logPayload?: boolean;
  allowLegacyFallback?: boolean;
  requestId?: string;
  timeoutMs?: number | null;
  onFailure?: (reason: HighlightFailureReason) => void;
}

async function generateHighlightsBatchRequest(
  endpoint: "/batch_highlight" | "/batch_highlight_indexed",
  query: string,
  pages: Array<HighlightPage | HighlightIndexedPage>,
  opts: HighlightBatchOptions,
  legacyPages?: HighlightPage[],
): Promise<Map<string, HighlightResult> | null> {
  if (pages.length === 0) {
    return new Map();
  }

  const controller = new AbortController();
  const timeoutMs =
    opts.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : opts.timeoutMs;
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const baseUrl = config.HIGHLIGHT_MODEL_URL!.replace(/\/$/, "");
    const res = await fetchBatchWithRetry(
      `${baseUrl}${endpoint}`,
      {
        method: "POST",
        headers: requestHeaders(opts.requestId),
        body: JSON.stringify({ query, pages }),
        signal: controller.signal,
      },
      controller.signal,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // During rollout the configured service may still be the legacy Modal
      // endpoint, whose /batch_highlight contract uses {requests: [...]}. Keep
      // highlights available until infra switches the URL to GCP Stage 1.
      if (
        legacyPages &&
        opts.allowLegacyFallback !== false &&
        (res.status === 400 || res.status === 404)
      ) {
        opts.logger.info("query highlights using legacy per-page fallback", {
          canonicalLog: "search/highlights",
          status: res.status,
        });
        return await generateLegacyHighlightsBatch(
          baseUrl,
          query,
          legacyPages,
          controller.signal,
          opts,
        );
      }
      throw new HighlightHttpError(res.status, body);
    }

    const data: unknown = await res.json();
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      ("pages" in data && !Array.isArray(data.pages))
    ) {
      throw new HighlightInvalidResponseError(
        "highlight model returned an invalid response",
      );
    }
    const results = new Map<string, HighlightResult>();
    for (const page of (data as HighlightBatchResponse).pages ?? []) {
      if (typeof page !== "object" || page === null) continue;
      if (typeof page.id !== "string" || !page.output) continue;
      results.set(page.id, {
        highlights: page.output.highlights ?? [],
        markdown: page.output.markdown ?? "",
      });
    }

    opts.logger.debug("query highlights batch", {
      canonicalLog: "search/highlights",
      requestedPages: pages.length,
      returnedPages: results.size,
      ...(opts.logPayload === false
        ? {}
        : {
            pages: Array.from(results, ([id, result]) => ({
              id,
              highlights: result.highlights,
            })),
          }),
      elapsedMs: Date.now() - start,
    });

    return results;
  } catch (error) {
    opts.onFailure?.(failureReason(error));
    opts.logger.warn("query highlights batch failed", {
      canonicalLog: "search/highlights",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function generateHighlightsBatch(
  query: string,
  pages: HighlightPage[],
  opts: HighlightBatchOptions,
): Promise<Map<string, HighlightResult> | null> {
  return generateHighlightsBatchRequest(
    "/batch_highlight",
    query,
    pages,
    opts,
    pages,
  );
}

export async function generateHighlightsIndexedBatch(
  query: string,
  pages: HighlightIndexedPage[],
  opts: Omit<HighlightBatchOptions, "allowLegacyFallback">,
): Promise<Map<string, HighlightResult> | null> {
  return generateHighlightsBatchRequest(
    "/batch_highlight_indexed",
    query,
    pages,
    { ...opts, allowLegacyFallback: false },
  );
}

async function generateLegacyHighlightsBatch(
  baseUrl: string,
  query: string,
  pages: HighlightPage[],
  signal: AbortSignal,
  opts: { logger: Logger; requestId?: string },
): Promise<Map<string, HighlightResult>> {
  const entries = await Promise.all(
    pages.map(async page => {
      try {
        const res = await fetch(`${baseUrl}/highlight`, {
          method: "POST",
          headers: requestHeaders(opts.requestId),
          body: JSON.stringify({ query, markdown: page.markdown }),
          signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(
            `highlight model HTTP ${res.status}: ${body.slice(0, 200)}`,
          );
        }
        const data = (await res.json()) as HighlightResponse;
        return [
          page.id,
          {
            highlights: data.highlights ?? [],
            markdown: data.markdown ?? "",
          },
        ] as const;
      } catch (error) {
        opts.logger.warn("legacy query highlight failed", {
          canonicalLog: "search/highlights",
          pageId: page.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );
  return new Map(entries.filter(entry => entry !== null));
}
