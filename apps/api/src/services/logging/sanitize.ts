/**
 * Text sanitizer for every value that leaves the logging boundary.
 *
 * Log rows go to two stores that disagree on what a string may contain:
 *
 * - PostgreSQL rejects a NUL byte anywhere in `text` or `jsonb`, including
 *   the escaped form JSON.stringify produces for it inside `jsonb`
 *   (error 22P05).
 * - ClickPipes parses the published JSON strictly and rejects an unpaired
 *   UTF-16 surrogate, which JSON.stringify emits as an escape such as
 *   `\udc81` when a client sends mis-decoded bytes. PostgreSQL's driver
 *   quietly stores the same character as U+FFFD.
 *
 * So the row is cleaned once, before the insert and the publish, and both
 * stores end up holding identical values: NUL bytes are dropped and lone
 * surrogates become U+FFFD, the same replacement PostgreSQL applies.
 */

// A quick pre-check so clean strings are returned untouched, no allocation.
const NEEDS_SANITIZING = /[\uD800-\uDFFF]|\x00/;

// One pass: a well-formed surrogate pair (kept as is), a lone surrogate
// (replaced), or a NUL byte (dropped). Ordering matters: the pair
// alternative must come first so valid pairs are never split.
const UNSAFE_TEXT = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]|\x00/g;

export function sanitizeText(value: string): string {
  if (!NEEDS_SANITIZING.test(value)) return value;
  return value.replace(UNSAFE_TEXT, match => {
    if (match.length === 2) return match;
    return match === "\x00" ? "" : "\uFFFD";
  });
}

/**
 * Deep-sanitizes a log row. Strings are cleaned wherever they appear: top
 * level, nested inside plain objects and arrays (the `options` and
 * `cost_tracking` JSON columns), and in object keys. Dates, Buffers and other
 * class instances are returned by reference, so `created_at` survives intact.
 */
export function sanitizeLogData<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeText(value) as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeLogData(item)) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[sanitizeText(key)] = sanitizeLogData(entry);
  }
  return out as T;
}
