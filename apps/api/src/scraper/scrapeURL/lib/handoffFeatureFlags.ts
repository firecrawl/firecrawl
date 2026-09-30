import type { FeatureFlag } from "../engines";

/**
 * The parser flags a file handoff can name. A file is exactly one of these:
 * the bytes (or header) that produced the handoff decide which.
 */
const FILE_FEATURE_FLAGS: ReadonlySet<FeatureFlag> = new Set<FeatureFlag>([
  "pdf",
  "document",
  "image",
]);

/**
 * Merges a handoff's feature flags into the request's set.
 *
 * A file flag the URL extension implied up front (the `pdf` of a .pdf URL
 * that turns out to serve a docx) is dropped when the handoff names a
 * different parser. The file flags weigh 100 each in buildFallbackList's
 * support threshold, so keeping both would demand a parser that handles both
 * types: with nothing else set the single-type parsers only just qualify, and
 * any further flag (location, stealthProxy, waitFor) pushes the threshold
 * past them, stranding a file that is already in hand.
 */
export function applyHandoffFeatureFlags(
  current: ReadonlySet<FeatureFlag>,
  added: readonly FeatureFlag[],
): Set<FeatureFlag> {
  const handedOff = added.filter(flag => FILE_FEATURE_FLAGS.has(flag));
  const next = new Set<FeatureFlag>();
  for (const flag of current) {
    if (
      handedOff.length > 0 &&
      FILE_FEATURE_FLAGS.has(flag) &&
      !handedOff.includes(flag)
    ) {
      continue;
    }
    next.add(flag);
  }
  for (const flag of added) {
    next.add(flag);
  }
  return next;
}
