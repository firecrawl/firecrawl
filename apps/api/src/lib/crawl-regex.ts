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

type PathPatternFields = {
  includePaths?: string[];
  excludePaths?: string[];
};

// Validate includePaths/excludePaths as a unit: first the request-wide budget,
// then each pattern against the engine. Nothing is compiled once any cap is
// exceeded, because the caps are what bound the compile work a request can
// demand and the request has already been rejected at that point.
export function addPathRegexIssues(
  fields: PathPatternFields,
  ctx: z.RefinementCtx,
): void {
  const include = fields.includePaths ?? [];
  const exclude = fields.excludePaths ?? [];
  if (include.length === 0 && exclude.length === 0) return;

  // Zod still runs this refinement when pathPatternsSchema has already reported
  // a per-field count or length violation, so re-check those caps here.
  const overFieldCap = (patterns: string[]) =>
    patterns.length > MAX_PATH_PATTERNS ||
    patterns.some(p => p.length > MAX_PATH_PATTERN_LENGTH);
  if (overFieldCap(include) || overFieldCap(exclude)) return;

  const totalCount = include.length + exclude.length;
  if (totalCount > MAX_TOTAL_PATH_PATTERNS) {
    ctx.addIssue({
      code: "custom",
      path: ["includePaths"],
      message: `includePaths and excludePaths together accept at most ${MAX_TOTAL_PATH_PATTERNS} patterns (got ${totalCount}).`,
    });
    return;
  }
  const totalChars = [...include, ...exclude].reduce(
    (sum, p) => sum + p.length,
    0,
  );
  if (totalChars > MAX_TOTAL_PATH_PATTERN_CHARS) {
    ctx.addIssue({
      code: "custom",
      path: ["includePaths"],
      message: `includePaths and excludePaths together accept at most ${MAX_TOTAL_PATH_PATTERN_CHARS} characters of patterns (got ${totalChars}).`,
    });
    return;
  }

  addFieldRegexIssues(include, "includePaths", ctx);
  addFieldRegexIssues(exclude, "excludePaths", ctx);
}

// Link filtering compiles includePaths/excludePaths with the Rust `regex` crate
// (RE2-style: no look-around or backreferences). Historically an unsupported
// pattern compiled fine in most clients' regex flavor but was silently dropped
// by the engine, so the paths it was meant to filter got crawled anyway. Reject
// such patterns up front with a message that points at the actual limitation.
function addFieldRegexIssues(
  patterns: string[],
  field: "includePaths" | "excludePaths",
  ctx: z.RefinementCtx,
): void {
  if (patterns.length === 0) return;
  for (const { pattern, error } of validateRegexes(patterns)) {
    const summary = summarizeRegexError(error);
    ctx.addIssue({
      code: "custom",
      path: [field],
      message:
        `Invalid ${field} pattern ${JSON.stringify(pattern)}: ${summary}. ` +
        `${field} patterns use Rust regex (RE2-style) syntax.${regexErrorHint(summary)}`,
    });
  }
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
