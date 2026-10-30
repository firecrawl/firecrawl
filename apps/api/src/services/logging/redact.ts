/**
 * Redaction for every row that leaves the logging boundary.
 *
 * Request options are stored on log rows as the caller sent them. Three
 * parts of them are credentials or internal plumbing and have no business in
 * a warehouse:
 *
 * - `headers`: the caller's headers for the target site (Authorization,
 *   Cookie, API keys under any name) and webhook delivery headers. Names are
 *   kept, since they describe how the request was made; values are replaced.
 * - `write` actions: the text typed into a page, which is where passwords go.
 * - `__`-prefixed fields: internal request plumbing (service-to-service auth,
 *   preview tokens, engine flags) that the public schema never exposes.
 *
 * Runs on the row before sanitizing, so both stores receive the same values.
 */

export const REDACTED = "<redacted>";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isHeaderMap(value: unknown): value is Record<string, string> {
  return (
    isPlainObject(value) &&
    Object.values(value).every(entry => typeof entry === "string")
  );
}

function redactHeaderMap(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.keys(headers).map(name => [name, REDACTED] as const),
  );
}

function redactAction(action: unknown): unknown {
  if (
    isPlainObject(action) &&
    action.type === "write" &&
    typeof action.text === "string"
  ) {
    return redactLogData({ ...action, text: REDACTED });
  }
  return redactLogData(action);
}

/**
 * Deep-redacts a log row. Plain objects and arrays are walked; Dates, Buffers
 * and other class instances are returned by reference.
 */
export function redactLogData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => redactLogData(item)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith("__")) continue;
    if (key === "headers" && isHeaderMap(entry)) {
      out[key] = redactHeaderMap(entry);
    } else if (key === "actions" && Array.isArray(entry)) {
      out[key] = entry.map(redactAction);
    } else {
      out[key] = redactLogData(entry);
    }
  }
  return out as T;
}
