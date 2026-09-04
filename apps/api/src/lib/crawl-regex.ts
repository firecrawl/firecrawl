import { validateRegexes } from "@mendable/firecrawl-rs";
import { z } from "zod";

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
    let message = `Invalid ${field} pattern ${JSON.stringify(pattern)}: ${summarizeRegexError(error)}. ${field} patterns use Rust regex (RE2-style) syntax.`;
    if (/look-around|look-ahead|look-behind|backreference/i.test(error)) {
      message +=
        " Look-around ((?=...), (?!...), (?<=...), (?<!...)) and backreferences are not supported.";
    }
    ctx.addIssue({ code: "custom", path: [field], message });
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
