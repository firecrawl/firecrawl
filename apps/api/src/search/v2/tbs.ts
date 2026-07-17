// Firecrawl exposes time filtering as Google-style `tbs` strings
// (e.g. "qdr:d" — confirmed by the Python/JS SDK docs and the API schema
// comment). Individual search providers consume different parameter shapes,
// so each maps the shared granularity to its own format. SearXNG takes
// time_range={day|week|month|year}; DuckDuckGo takes df={d|w|m|y}.
//
// This module owns the single parse of `tbs` -> a granularity letter, so the
// two providers cannot drift on input handling.

export type TbsGranularity = "h" | "d" | "w" | "m" | "y";

const GRANULARITIES: readonly TbsGranularity[] = ["h", "d", "w", "m", "y"];

// Accepts both the canonical "qdr:<g>" form and a bare granularity letter
// (trimmed, case-insensitive). Returns undefined for custom date ranges
// (cdr:...) and anything unrecognized.
export function parseTbsGranularity(tbs?: string): TbsGranularity | undefined {
  if (typeof tbs !== "string") return undefined;
  const cleaned = tbs.trim().toLowerCase();
  const matched = cleaned.match(/qdr:([hdwmy])/)?.[1];
  if (matched) return matched as TbsGranularity;
  return GRANULARITIES.includes(cleaned as TbsGranularity)
    ? (cleaned as TbsGranularity)
    : undefined;
}
