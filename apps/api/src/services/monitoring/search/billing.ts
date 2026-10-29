const SEARCH_CREDITS_PER_TEN_RESULTS = 2;
const SEARCH_CREDITS_PER_TEN_RESULTS_ZDR = 10;
// Single source of truth for the judge credit rate; import it rather than re-declaring (a duplicate literal previously drifted to 5).
export const SEARCH_JUDGE_CREDITS_PER_RESULT = 1;

export function searchCreditsForResultCount(
  rawResultCount: number,
  isZDR: boolean,
): number {
  const perBatch = isZDR
    ? SEARCH_CREDITS_PER_TEN_RESULTS_ZDR
    : SEARCH_CREDITS_PER_TEN_RESULTS;
  return Math.ceil(Math.max(0, rawResultCount) / 10) * perBatch;
}

export function judgeCreditsForJudgedCount(judgedCount: number): number {
  return Math.max(0, judgedCount) * SEARCH_JUDGE_CREDITS_PER_RESULT;
}
