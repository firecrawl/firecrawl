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

// Result for one page in the batch: the service's highlight entries plus the
// reassembled markdown document.
interface HighlightResult {
  highlights: Highlight[];
  markdown: string;
}

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
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
export async function generateHighlightsBatch(
  query: string,
  pages: HighlightPage[],
  opts: { logger: Logger },
): Promise<Map<string, HighlightResult> | null> {
  if (pages.length === 0) {
    return new Map();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const baseUrl = config.HIGHLIGHT_MODEL_URL!.replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/batch_highlight`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ query, pages }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // During rollout the configured service may still be the legacy Modal
      // endpoint, whose /batch_highlight contract uses {requests: [...]}. Keep
      // highlights available until infra switches the URL to GCP Stage 1.
      if (res.status === 400 || res.status === 404) {
        opts.logger.info("query highlights using legacy per-page fallback", {
          canonicalLog: "search/highlights",
          status: res.status,
        });
        return await generateLegacyHighlightsBatch(
          baseUrl,
          query,
          pages,
          controller.signal,
          opts,
        );
      }
      throw new Error(
        `highlight model HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as HighlightBatchResponse;
    const results = new Map<string, HighlightResult>();
    for (const page of data.pages ?? []) {
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
      pages: Array.from(results, ([id, result]) => ({
        id,
        highlights: result.highlights,
      })),
      elapsedMs: Date.now() - start,
    });

    return results;
  } catch (error) {
    opts.logger.warn("query highlights batch failed", {
      canonicalLog: "search/highlights",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function generateLegacyHighlightsBatch(
  baseUrl: string,
  query: string,
  pages: HighlightPage[],
  signal: AbortSignal,
  opts: { logger: Logger },
): Promise<Map<string, HighlightResult>> {
  const entries = await Promise.all(
    pages.map(async page => {
      try {
        const res = await fetch(`${baseUrl}/highlight`, {
          method: "POST",
          headers: requestHeaders(),
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
