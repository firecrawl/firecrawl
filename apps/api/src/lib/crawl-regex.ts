import { validateRegexes } from "@mendable/firecrawl-rs";
import { z } from "zod";

// Every pattern is compiled by the engine at request time (validation) and again
// when links are filtered, so the amount of work a single request can demand is
// count x per-pattern cost. The engine bounds per-pattern cost (see
// compile_path_regex in native/src/crawler.rs); these bound the count and the
// pattern length, which is what parsing cost scales with.
export const MAX_PATH_PATTERNS = 100;
export const MAX_PATH_PATTERN_LENGTH = 2000;

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

// Link filtering compiles includePaths/excludePaths with the Rust `regex` crate
// (RE2-style: no look-around or backreferences). Historically an unsupported
// pattern compiled fine in most clients' regex flavor but was silently dropped
// by the engine, so the paths it was meant to filter got crawled anyway. Reject
// such patterns up front with a message that points at the actual limitation.
export function addPathRegexIssues(
  patterns: string[] | undefined,
  field: "includePaths" | "excludePaths",
  ctx: z.RefinementCtx,
): void {
  if (!patterns || patterns.length === 0) return;
  for (const { pattern, error } of validateRegexes(patterns)) {
    const hint = regexErrorHint(error);
    ctx.addIssue({
      code: "custom",
      path: [field],
      message:
        `Invalid ${field} pattern ${JSON.stringify(pattern)}: ${summarizeRegexError(error)}. ` +
        `${field} patterns use Rust regex (RE2-style) syntax.${hint}`,
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
function regexErrorHint(error: string): string {
  if (/look-around|look-ahead|look-behind|backreference/i.test(error)) {
    return " Rewrite the pattern using only constructs the engine supports, for example by listing the paths to keep in includePaths instead.";
  }
  if (/exceeds size limit/i.test(error)) {
    return " The pattern expands to too many states when compiled, usually because of large or stacked counted repetitions such as {1000} or {5}{5}{5}. Lower the counts or use unbounded quantifiers like + and * instead.";
  }
  if (/Unicode not allowed/i.test(error)) {
    return " Patterns are matched against percent-encoded ASCII URLs, so Unicode-only constructs such as \\p{..} classes or non-ASCII characters inside [...] can never match. Remove them or match the percent-encoded form instead.";
  }
  return "";
}
