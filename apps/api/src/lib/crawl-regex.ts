import { validateRegexes } from "@mendable/firecrawl-rs";
import { z } from "zod";

// Every pattern is compiled by the engine at request time (validation) and again
// when links are filtered, so the amount of work a single request can demand is
// count x per-pattern cost. The engine bounds per-pattern cost (see
// compile_path_regex in native/src/crawler.rs); these bound the count and the
// pattern length, which is what parsing cost scales with.
//
// Keyword-style filtering (one short pattern per term) routinely needs a few
// hundred patterns per field, so the count cap has headroom for that. Measured
// against the native module, 1000 short keyword patterns compile in ~2 ms.
export const MAX_PATH_PATTERNS = 1000;
export const MAX_PATH_PATTERN_LENGTH = 2000;

// includePaths and excludePaths are compiled together, so the per-field caps
// alone would let one request demand 2 x 1000 x 2000 characters of compile
// work. These bound the request as a whole: total pattern count and total
// pattern characters across both fields. The worst case that fits (1000
// patterns whose combined length is 100k characters) compiles in ~120 ms on the
// native module, versus ~700 ms for the unbudgeted per-field maximum.
export const MAX_TOTAL_PATH_PATTERNS = 1000;
export const MAX_TOTAL_PATH_PATTERN_CHARS = 100_000;

export const pathPatternsSchema = z
  .string()
  .max(
    MAX_PATH_PATTERN_LENGTH,
    `Each includePaths/excludePaths pattern must be at most ${MAX_PATH_PATTERN_LENGTH} characters.`,
  )
  .array()
  .max(
    MAX_PATH_PATTERNS,
    `includePaths and excludePaths each accept at most ${MAX_PATH_PATTERNS} patterns.`,
  );

type PathPatternField = "includePaths" | "excludePaths";

// Values are `unknown` because the v2 crawl controller passes crawler options
// that were partly produced by an LLM from a `prompt`, which may return the
// wrong shape entirely (a string instead of an array, numbers in the array).
type PathPatternFields = {
  includePaths?: unknown;
  excludePaths?: unknown;
};

type PathPatternIssue = {
  // "shape": the field is not an array of strings.
  // "field-cap": a single field exceeds its count or length cap.
  // "budget": both fields together exceed the request-wide budget.
  // "syntax": a pattern does not compile with the engine.
  kind: "shape" | "field-cap" | "budget" | "syntax";
  // Empty for request-wide (cross-field) issues.
  path: PathPatternField[];
  message: string;
};

// Validate includePaths/excludePaths as a unit: the per-field caps, then the
// request-wide budget, then each pattern against the engine. Nothing is
// compiled once any cap is exceeded, because the caps are what bound the
// compile work a request can demand.
//
// This is the single source of truth for what path patterns are accepted. The
// request schemas call it through addPathRegexIssues; the v2 crawl controller
// calls it directly on the final crawler options, because includePaths /
// excludePaths generated from a crawl `prompt` are merged in after schema
// validation and must meet the same limits before they reach the crawler.
export function collectPathPatternIssues(
  fields: PathPatternFields,
): PathPatternIssue[] {
  const shapeIssues: PathPatternIssue[] = [];
  const asPatterns = (field: PathPatternField): string[] => {
    const value = fields[field];
    if (value === undefined || value === null) return [];
    if (Array.isArray(value) && value.every(p => typeof p === "string")) {
      return value;
    }
    shapeIssues.push({
      kind: "shape",
      path: [field],
      message: `${field} must be an array of strings.`,
    });
    return [];
  };
  const include = asPatterns("includePaths");
  const exclude = asPatterns("excludePaths");
  if (shapeIssues.length > 0) return shapeIssues;
  if (include.length === 0 && exclude.length === 0) return [];

  const capIssues: PathPatternIssue[] = [];
  for (const [field, patterns] of [
    ["includePaths", include],
    ["excludePaths", exclude],
  ] as const) {
    if (patterns.length > MAX_PATH_PATTERNS) {
      capIssues.push({
        kind: "field-cap",
        path: [field],
        message: `includePaths and excludePaths each accept at most ${MAX_PATH_PATTERNS} patterns.`,
      });
    }
    if (patterns.some(p => p.length > MAX_PATH_PATTERN_LENGTH)) {
      capIssues.push({
        kind: "field-cap",
        path: [field],
        message: `Each includePaths/excludePaths pattern must be at most ${MAX_PATH_PATTERN_LENGTH} characters.`,
      });
    }
  }
  if (capIssues.length > 0) return capIssues;

  const totalCount = include.length + exclude.length;
  if (totalCount > MAX_TOTAL_PATH_PATTERNS) {
    return [
      {
        kind: "budget",
        path: [],
        message: `includePaths and excludePaths together accept at most ${MAX_TOTAL_PATH_PATTERNS} patterns (got ${totalCount}).`,
      },
    ];
  }
  const totalChars = [...include, ...exclude].reduce(
    (sum, p) => sum + p.length,
    0,
  );
  if (totalChars > MAX_TOTAL_PATH_PATTERN_CHARS) {
    return [
      {
        kind: "budget",
        path: [],
        message: `includePaths and excludePaths together accept at most ${MAX_TOTAL_PATH_PATTERN_CHARS} characters of patterns (got ${totalChars}).`,
      },
    ];
  }

  return [
    ...fieldRegexIssues(include, "includePaths"),
    ...fieldRegexIssues(exclude, "excludePaths"),
  ];
}

// Zod refinement wrapper around collectPathPatternIssues. Zod still runs this
// refinement when pathPatternsSchema has already reported a per-field count or
// length violation, so those are not reported a second time here.
export function addPathRegexIssues(
  fields: PathPatternFields,
  ctx: z.RefinementCtx,
): void {
  for (const issue of collectPathPatternIssues(fields)) {
    if (issue.kind === "field-cap") continue;
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
}

// Link filtering compiles includePaths/excludePaths with the Rust `regex` crate
// (RE2-style: no look-around or backreferences). Historically an unsupported
// pattern compiled fine in most clients' regex flavor but was silently dropped
// by the engine, so the paths it was meant to filter got crawled anyway. Reject
// such patterns up front with a message that points at the actual limitation.
function fieldRegexIssues(
  patterns: string[],
  field: PathPatternField,
): PathPatternIssue[] {
  if (patterns.length === 0) return [];
  return validateRegexes(patterns).map(({ pattern, error }) => {
    const summary = summarizeRegexError(error);
    return {
      kind: "syntax",
      path: [field],
      message:
        `Invalid ${field} pattern ${JSON.stringify(pattern)}: ${summary}. ` +
        `${field} patterns use Rust regex (RE2-style) syntax.${regexErrorHint(summary)}`,
    };
  });
}

function summarizeRegexError(error: string): string {
  const line = error
    .split("\n")
    .map(l => l.trim())
    .reverse()
    .find(l => l.startsWith("error:"));
  return (line ?? error.split("\n")[0] ?? error).replace(/^error:\s*/, "");
}

// The engine's own error already names the failing construct, so only add an
// actionable hint for the errors where the fix is not obvious from the message.
// Takes the summarized `error:` line, not the full diagnostic, which quotes the
// user's pattern and could otherwise trigger a hint by containing these words.
function regexErrorHint(summary: string): string {
  if (/look-around|look-ahead|look-behind|backreference/i.test(summary)) {
    return " Rewrite the pattern using only constructs the engine supports, for example by listing the paths to keep in includePaths instead.";
  }
  if (/exceeds size limit/i.test(summary)) {
    return " The pattern expands to too many states when compiled, usually because of large or stacked counted repetitions such as {1000} or {5}{5}{5}. Lower the counts or use unbounded quantifiers like + and * instead.";
  }
  if (/Unicode not allowed/i.test(summary)) {
    return " Patterns are matched against percent-encoded ASCII URLs, so Unicode-only constructs such as \\p{..} classes or non-ASCII characters inside [...] can never match. Remove them or match the percent-encoded form instead.";
  }
  return "";
}
