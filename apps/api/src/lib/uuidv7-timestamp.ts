/**
 * Millisecond Unix timestamp embedded in a UUIDv7, or null when `id` is not a
 * v7 UUID. Scrape ids are v7, so this yields a scrape's age from the id alone,
 * with no database read. Used to tell a genuinely unknown id from a row that
 * is too new for the read replica to have caught up on.
 */
export function uuidv7TimestampMs(id: string): number | null {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") {
    return null;
  }
  return parseInt(hex.slice(0, 12), 16);
}

/**
 * Milliseconds elapsed since a UUIDv7 was minted, or null for non-v7 ids.
 */
export function uuidv7AgeMs(
  id: string,
  now: number = Date.now(),
): number | null {
  const ts = uuidv7TimestampMs(id);
  return ts === null ? null : now - ts;
}
