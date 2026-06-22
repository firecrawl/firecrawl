import type { Logger } from "winston";
import { config } from "../config";

// Query Highlights model service: given a page's full markdown and a query, the
// service returns the query-relevant highlights plus those highlights
// reassembled into a single markdown document (in document order). We push each
// page through one `/highlight` call. Endpoint + token are config-gated
// (HIGHLIGHT_MODEL_URL / HIGHLIGHT_MODEL_TOKEN); callers must confirm they're
// set via highlightsEnvReady() before invoking.

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

// Result of one highlight call: the service's highlight entries plus the
// reassembled markdown document.
interface HighlightResult {
  highlights: Highlight[];
  markdown: string;
}

/**
 * Generate query highlights for one page by sending its full markdown and the
 * query to the highlight model service. Returns the service's highlight entries
 * plus the reassembled markdown, or null when the call fails (so callers can
 * keep the provider snippet).
 */
export async function generateHighlights(
  query: string,
  markdown: string,
  opts: { logger: Logger },
): Promise<HighlightResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(`${config.HIGHLIGHT_MODEL_URL}/highlight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.HIGHLIGHT_MODEL_TOKEN}`,
      },
      body: JSON.stringify({ query, markdown }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `highlight model HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as HighlightResponse;
    const highlights = data.highlights ?? [];

    // Canonical log of the highlights array, debug-level only.
    opts.logger.debug("query highlights", {
      canonicalLog: "search/highlights",
      highlights,
      elapsedMs: Date.now() - start,
    });

    return { highlights, markdown: data.markdown ?? "" };
  } catch (error) {
    opts.logger.warn("query highlights failed", {
      canonicalLog: "search/highlights",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
