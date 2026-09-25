import {
  resolveSearchCostPerTenResults,
  searchCreditsForResults,
} from "../../../lib/search-credits";

// Single source of truth for the judge credit rate; import it rather than re-declaring (a duplicate literal previously drifted to 5).
export const SEARCH_JUDGE_CREDITS_PER_RESULT = 1;

export function searchCreditsForResultCount(
  rawResultCount: number,
  isZDR: boolean,
): number {
  // Monitoring stays on list price: store.ts quotes setup estimates with
  // isZDR false, so a per-org rate would make the estimate and the billed
  // amount disagree. Pass no flags on purpose.
  return searchCreditsForResults(
    rawResultCount,
    resolveSearchCostPerTenResults(undefined, isZDR),
  );
}

export function judgeCreditsForJudgedCount(judgedCount: number): number {
  return Math.max(0, judgedCount) * SEARCH_JUDGE_CREDITS_PER_RESULT;
}
