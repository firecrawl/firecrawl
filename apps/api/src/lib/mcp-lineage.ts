// Formats of the fields that tie a hosted MCP call to its session and
// conversation, shared by the MCP action log and stored feedback so both
// validate them the same way.
export const SECRET_PATTERN =
  /(?:\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:sk-|fc-|fco_|fcr_|fcmcp_)[A-Za-z0-9_-]+)/i;
export const SECRET_PATTERN_ALL = new RegExp(SECRET_PATTERN.source, "gi");
export const OBJECTIVE_MAX_LENGTH = 1000;
export const LINEAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const SESSION_SOURCES = ["token", "trace", "sse"] as const;
export const THREAD_SOURCES = [
  "argument",
  "session",
  "minted",
  "client",
] as const;
export const LINEAGE_ID_SECRET_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:sk-|fc-|fco_|fcr_|fcmcp_)/i;

/**
 * Free text from a call, such as its objective: control characters become
 * spaces, secret-like values become [redacted], and the result is cut to
 * `max` characters. Null when nothing is left.
 */
export function redactText(
  value: string,
  max: number,
  scrub: (text: string) => string = text => text,
): string | null {
  const normalized = scrub(
    value.slice(0, max * 4).replace(/[\u0000-\u001F\u007F-\u009F]+/g, " "),
  )
    .replace(SECRET_PATTERN_ALL, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_.-]*$/, "[redacted]")
    .trim()
    .slice(0, max)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trim();
  return normalized || null;
}
