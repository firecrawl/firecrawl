import { CostTracking } from "../../../lib/cost-tracking";
import { recordLlmCall } from "./cost";
import {
  SEARCH_JUDGE_CREDITS_PER_RESULT,
  judgeCreditsForJudgedCount,
} from "./billing";

describe("search-monitor LLM cost recording (observability only)", () => {
  it("records token usage into the shared CostTracking with no dollar cost", () => {
    const ct = new CostTracking();
    recordLlmCall({
      costTracking: ct,
      model: "gemini-flash-lite-latest",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      stage: "routeSearchResults",
    });
    const json = ct.toJSON();
    // Tokens recorded for observability; cost stays 0 (flat per-result billing).
    expect(json.totalCost).toBe(0);
    expect(json.calls[0].tokens).toEqual({
      input: 1_000_000,
      output: 1_000_000,
    });
  });

  it("normalizes promptTokens/completionTokens (older SDK usage shape)", () => {
    const ct = new CostTracking();
    recordLlmCall({
      costTracking: ct,
      model: "gemini-flash-lite-latest",
      usage: { promptTokens: 1_000_000, completionTokens: 0 },
      stage: "summarizeRun",
    });
    expect(ct.toJSON().calls[0].tokens).toEqual({
      input: 1_000_000,
      output: 0,
    });
  });
});

describe("search-monitor FLAT judge billing rate", () => {
  it("is a deterministic 1 credit per judged result", () => {
    expect(SEARCH_JUDGE_CREDITS_PER_RESULT).toBe(1);
  });

  it("computes judge credits as 1 * resultsJudged", () => {
    expect(judgeCreditsForJudgedCount(0)).toBe(0);
    expect(judgeCreditsForJudgedCount(3)).toBe(3);
    expect(judgeCreditsForJudgedCount(10)).toBe(10);
  });
});

// Billed count == pages with judgedThisRun=true: reused/skipped pages keep a
// stale concept but aren't judged, so concept count overcounts.
describe("canonical judged-result count (billing == persisted signal)", () => {
  type Page = {
    searchStatus: string;
    judgedThisRun?: boolean;
    concept?: string;
  };
  const billedJudgedCount = (pages: Page[]) =>
    pages.filter(p => p.judgedThisRun === true).length;

  it("counts judgedThisRun=true, NOT every page nor every page with a concept", () => {
    // 1 judged this run; 2 reused (stale concept, not judged); 1 skipped.
    const pages: Page[] = [
      { searchStatus: "alert", judgedThisRun: true, concept: "fresh-verdict" },
      {
        searchStatus: "already_seen",
        judgedThisRun: false,
        concept: "stale-1",
      },
      { searchStatus: "watching", judgedThisRun: false, concept: "stale-2" },
      { searchStatus: "skipped" },
    ];
    expect(pages.filter(p => p.concept).length).toBe(3); // misleading count
    expect(billedJudgedCount(pages)).toBe(1); // canonical billed count
    expect(judgeCreditsForJudgedCount(billedJudgedCount(pages))).toBe(1);
  });

  it("counts judged results across every billed outcome (alert/watch/ignore/already_seen)", () => {
    const pages: Page[] = [
      { searchStatus: "alert", judgedThisRun: true },
      { searchStatus: "watching", judgedThisRun: true },
      { searchStatus: "ignored", judgedThisRun: true },
      { searchStatus: "already_seen", judgedThisRun: true },
      { searchStatus: "skipped" }, // verdict failed -> not billed
    ];
    expect(billedJudgedCount(pages)).toBe(4); // -> 4 judge credits
  });
});
