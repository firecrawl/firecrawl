/**
 * Single source of truth for the search credit rate.
 *
 * The rate can come from the per-organization `searchCostPerTenResults` flag,
 * which may be fractional. `organizations.flags` is an opaque JSON blob with no
 * schema, so the value is validated here and every call site inherits the
 * guard. The charge carries the exact decimal: Autumn accepts decimals, so a
 * rate of 2.5 bills exactly 2.5. Records that hold only whole numbers round the
 * value on their own side.
 */

const DEFAULT_SEARCH_COST_PER_TEN_RESULTS = 2;
const DEFAULT_SEARCH_COST_PER_TEN_RESULTS_ZDR = 10;

type SearchCostFlags = { searchCostPerTenResults?: number } | null | undefined;

/**
 * Returns the effective credits per 10 returned results. Falls back to list
 * price unless the flag holds a usable positive finite number.
 */
export function resolveSearchCostPerTenResults(
  flags: SearchCostFlags,
  isZDR: boolean,
): number {
  const flagValue = flags?.searchCostPerTenResults;
  if (
    flagValue !== undefined &&
    Number.isFinite(flagValue) &&
    (flagValue as number) > 0
  ) {
    return flagValue as number;
  }
  return isZDR
    ? DEFAULT_SEARCH_COST_PER_TEN_RESULTS_ZDR
    : DEFAULT_SEARCH_COST_PER_TEN_RESULTS;
}

/**
 * Returns the exact search charge. Results bill in blocks of ten, and each
 * block costs the rate, so the value can be fractional. It is not rounded:
 * each integer-only record (such as the ledger or a `credits_cost` column)
 * rounds it where it writes.
 */
export function searchCreditsForResults(
  resultCount: number,
  costPerTenResults: number,
): number {
  return Math.ceil(Math.max(0, resultCount) / 10) * costPerTenResults;
}
