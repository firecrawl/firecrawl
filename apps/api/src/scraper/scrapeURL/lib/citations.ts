/**
 * Grounded-citation resolution for PDF extraction (ENG-4963).
 *
 * The extraction LLM returns per-field verbatim supporting quotes; this
 * module maps each quote back to page + bbox through fire-pdf's block
 * spans — the model is never trusted with coordinates (LlamaParse
 * architecture). fire-pdf blocks carry `markdown_span`: [start, end)
 * character offsets into the full returned markdown, emitted in
 * ascending order, so overlap lookup is a binary search.
 *
 * A quote that cannot be located degrades to no citations for that
 * field — an honest ungrounded signal rather than a guessed location.
 */

/** Subset of fire-pdf's block fields the resolver needs (blocks-schema v2). */
export interface GroundingBlock {
  id: string;
  bbox: [number, number, number, number] | null;
  markdown_span: [number, number] | null;
}

export interface GroundingBlockPage {
  page: number;
  blocks: GroundingBlock[];
}

export interface Citation {
  /** 1-based page number, matching fire-pdf's `<!-- page N -->` markers. */
  page: number;
  /** Normalized [x0, y0, x1, y1] in 0–1 page coordinates; null when the
   * source block had no grounded bbox. */
  bbox: [number, number, number, number] | null;
  /** The verbatim markdown slice the quote matched. */
  text: string;
  /** fire-pdf block id (`p<page>.b<n>`), stable within the response. */
  blockId: string;
}

interface SpanEntry {
  start: number;
  end: number;
  page: number;
  block: GroundingBlock;
}

/**
 * Locate `quote` in `markdown`, tolerating the whitespace and case drift
 * LLMs introduce when quoting. Returns [start, end) offsets into the
 * ORIGINAL markdown, or null.
 *
 * Strategy: exact match first; then a whitespace-collapsed search (every
 * whitespace run treated as one space) with an offset map back to the
 * original string; then the same, case-folded. First occurrence wins.
 */
export function locateQuote(markdown: string, quote: string): [number, number] | null {
  const trimmed = quote.trim();
  if (!trimmed) return null;

  const exact = markdown.indexOf(trimmed);
  if (exact >= 0) return [exact, exact + trimmed.length];

  // Whitespace-collapsed view of the markdown with a map from collapsed
  // offsets back to original offsets.
  const collapsed: string[] = [];
  const offsetMap: number[] = [];
  let lastWasSpace = true; // leading whitespace collapses away
  for (let i = 0; i < markdown.length; i++) {
    const ch = markdown[i]!;
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        collapsed.push(" ");
        offsetMap.push(i);
        lastWasSpace = true;
      }
    } else {
      collapsed.push(ch);
      offsetMap.push(i);
      lastWasSpace = false;
    }
  }
  const haystack = collapsed.join("");
  const needle = trimmed.replace(/\s+/g, " ");

  let at = haystack.indexOf(needle);
  if (at < 0) at = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return null;

  const start = offsetMap[at]!;
  const endInclusive = offsetMap[at + needle.length - 1]!;
  return [start, endInclusive + 1];
}

/** Flatten block pages into an ascending span index (blocks without spans
 * cannot ground anything and are skipped). */
function buildSpanIndex(blockPages: GroundingBlockPage[]): SpanEntry[] {
  const entries: SpanEntry[] = [];
  for (const page of blockPages) {
    for (const block of page.blocks) {
      if (!block.markdown_span) continue;
      entries.push({ start: block.markdown_span[0], end: block.markdown_span[1], page: page.page, block });
    }
  }
  entries.sort((a, b) => a.start - b.start);
  return entries;
}

/** Binary search: index of the first span whose end is greater than `pos`. */
function firstSpanEndingAfter(entries: SpanEntry[], pos: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.end <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Ground one quote: locate it in the markdown, then collect every block
 * whose span overlaps the matched range (quotes may cross block
 * boundaries — each overlapping block contributes one citation).
 */
export function groundQuote(markdown: string, spanIndex: SpanEntry[], quote: string): Citation[] {
  const range = locateQuote(markdown, quote);
  if (!range) return [];
  const [start, end] = range;
  const citations: Citation[] = [];
  for (let i = firstSpanEndingAfter(spanIndex, start); i < spanIndex.length && spanIndex[i]!.start < end; i++) {
    const entry = spanIndex[i]!;
    citations.push({
      page: entry.page,
      bbox: entry.block.bbox,
      text: markdown.slice(Math.max(start, entry.start), Math.min(end, entry.end)),
      blockId: entry.block.id,
    });
  }
  return citations;
}

/**
 * Ground all fields' quotes. `quotesByField` maps a JSON field path
 * (e.g. "total_revenue" or "items[2].name") to the verbatim quotes the
 * extraction model cited for it. Fields whose quotes don't locate map
 * to an empty array.
 */
export function groundCitations(
  markdown: string,
  blockPages: GroundingBlockPage[],
  quotesByField: Record<string, string[]>,
): Record<string, Citation[]> {
  const spanIndex = buildSpanIndex(blockPages);
  const out: Record<string, Citation[]> = {};
  for (const [field, quotes] of Object.entries(quotesByField)) {
    const citations: Citation[] = [];
    const seen = new Set<string>();
    for (const quote of quotes ?? []) {
      for (const c of groundQuote(markdown, spanIndex, quote)) {
        // One citation per block per field — multiple quotes often land
        // in the same block and duplicates carry no information.
        if (seen.has(c.blockId)) continue;
        seen.add(c.blockId);
        citations.push(c);
      }
    }
    out[field] = citations;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction-side helpers: schema wrapping and result splitting. The
// extraction schema is wrapped as { data: <user schema>, citations:
// { "<field.path>": [verbatim quotes] } } so one LLM call returns both the
// user's object (untouched shape) and the supporting quotes to ground.
// ---------------------------------------------------------------------------

export const CITATIONS_PROMPT_ADDENDUM =
  "Additionally, for every field you extract, add an entry to `citations` with the field's JSON " +
  'path within `data` (e.g. "total_revenue" or "items[2].name") and the exact verbatim quote(s) ' +
  "from the content that support that field's value. Quotes must be copied character-for-character " +
  "from the content — do not paraphrase, translate, or normalize them. If no supporting text " +
  "exists for a field, omit that field from `citations`.";

/**
 * Wrap the user's extraction schema so the model returns data + quotes.
 * OpenAI strict structured outputs forbid free-form maps
 * (`additionalProperties` must be false everywhere), so citations are an
 * array of { field, quotes } entries rather than a keyed object. The user
 * schema itself already passed the OpenAI-strictness validation at request
 * parse time.
 */
export function wrapSchemaWithCitations(userSchema: unknown): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      data: userSchema,
      citations: {
        type: "array",
        description:
          "One entry per extracted field: its JSON path in `data` and the exact verbatim quotes from the content supporting the value.",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            quotes: { type: "array", items: { type: "string" } },
          },
          required: ["field", "quotes"],
          additionalProperties: false,
        },
      },
    },
    required: ["data", "citations"],
    additionalProperties: false,
  };
}

/**
 * Split a wrapped extraction result back into the user's data object and a
 * normalized quotes map. Returns null when the result doesn't carry the
 * wrapper shape (model ignored the wrapper) — callers should fall back to
 * treating the raw result as the data, ungrounded.
 */
export function splitCitedExtraction(
  raw: unknown,
): { data: unknown; quotesByField: Record<string, string[]> } | null {
  if (raw === null || typeof raw !== "object" || !("data" in raw)) return null;
  const obj = raw as Record<string, unknown>;
  const quotesByField: Record<string, string[]> = {};
  const citations = obj.citations;
  if (Array.isArray(citations)) {
    for (const entry of citations) {
      if (entry === null || typeof entry !== "object") continue;
      const { field, quotes } = entry as Record<string, unknown>;
      if (typeof field !== "string") continue;
      const list =
        typeof quotes === "string"
          ? [quotes]
          : Array.isArray(quotes)
            ? quotes.filter((q): q is string => typeof q === "string")
            : [];
      quotesByField[field] = [...(quotesByField[field] ?? []), ...list];
    }
  }
  return { data: obj.data, quotesByField };
}
