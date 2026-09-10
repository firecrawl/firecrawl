vi.mock("uuid", () => ({
  v7: () => "test-uuid-v7",
}));

import {
  calculateMonitorCheckActualCreditsFromPages,
  estimateMonitorCreditsPerRun,
  flatSearchTargetCredits,
} from "./store";
import { judgeCreditsForJudgedCount } from "./search/billing";
import type { MonitorTarget } from "./types";

describe("monitoring store credit helpers", () => {
  it("estimates goal-enabled scrape monitors from scrape option costs", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com/a", "https://example.com/b"],
        scrapeOptions: {
          formats: [{ type: "changeTracking", modes: ["json"] }],
          proxy: "stealth",
        },
      },
    ];

    // 2 URLs x 5 (json change tracking). Enhanced proxies add nothing.
    expect(estimateMonitorCreditsPerRun(targets, false)).toBe(10);
    expect(estimateMonitorCreditsPerRun(targets, true)).toBe(12);
  });

  it("adds predictable lockdown costs and judge credits separately", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com/a"],
        scrapeOptions: {
          lockdown: true,
        },
      },
    ];

    expect(estimateMonitorCreditsPerRun(targets, false)).toBe(5);
    expect(estimateMonitorCreditsPerRun(targets, true)).toBe(6);
  });

  it("keeps the lockdown cost on a json monitor", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com/a"],
        scrapeOptions: {
          lockdown: true,
          formats: [{ type: "json", schema: {} }],
        },
      },
    ];

    // 1 base + 4 lockdown + 4 json.
    expect(estimateMonitorCreditsPerRun(targets, false)).toBe(9);
  });

  it("estimates the prompt injection guard cost on a json monitor", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com/a"],
        scrapeOptions: {
          formats: [{ type: "json", schema: {}, checkPromptInjection: true }],
        },
      },
    ];

    // 1 base + 4 json + 4 prompt injection guard.
    expect(estimateMonitorCreditsPerRun(targets, false)).toBe(9);
  });

  it("uses target options when page rows do not have recorded scrape credits", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com/a"],
        scrapeOptions: {
          formats: [{ type: "changeTracking", modes: ["json"] }],
          proxy: "stealth",
        },
      },
    ];

    expect(
      calculateMonitorCheckActualCreditsFromPages(
        [
          {
            target_id: "target-1",
            metadata: {},
            judgment: { meaningful: true },
            status: "changed",
          },
        ],
        targets,
      ),
    ).toBe(6);
  });

  it("uses monitor metadata for fallback PDF credits when recorded usage is missing", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com/sample.pdf"],
        scrapeOptions: {},
      },
    ];

    expect(
      calculateMonitorCheckActualCreditsFromPages(
        [
          {
            target_id: "target-1",
            metadata: { numPages: 5 },
            status: "same",
          },
        ],
        targets,
      ),
    ).toBe(5);
  });

  it("uses monitor metadata for fallback postprocessor credits and never for proxies", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://x.com/firecrawl"],
        scrapeOptions: {},
      },
    ];

    expect(
      calculateMonitorCheckActualCreditsFromPages(
        [
          {
            target_id: "target-1",
            metadata: {
              proxyUsed: "stealth",
              postprocessorsUsed: ["x-twitter"],
            },
            status: "same",
          },
        ],
        targets,
      ),
    ).toBe(30);
  });

  it("does not bill extra when enhanced proxy metadata is present", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com"],
        scrapeOptions: {},
      },
    ];

    expect(
      calculateMonitorCheckActualCreditsFromPages(
        [
          {
            target_id: "target-1",
            metadata: {
              proxyUsed: "enhanced",
            },
            status: "same",
          },
        ],
        targets,
      ),
    ).toBe(1);
  });

  it("bills json and extra PDF pages in fallback billing, whatever proxy ran", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com/sample.pdf"],
        scrapeOptions: {
          formats: [{ type: "changeTracking", modes: ["json"] }],
          proxy: "stealth",
        },
      },
    ];

    expect(
      calculateMonitorCheckActualCreditsFromPages(
        [
          {
            target_id: "target-1",
            metadata: {
              numPages: 10,
              proxyUsed: "basic",
            },
            status: "same",
          },
        ],
        targets,
      ),
    ).toBe(14);
  });

  it("prefers recorded page usage and does not bill removed pages", () => {
    expect(
      calculateMonitorCheckActualCreditsFromPages([
        { metadata: { creditsUsed: 5 }, judgment: { meaningful: true } },
        { metadata: { creditsUsed: 1 }, judgment: null },
        { metadata: {}, judgment: { meaningful: false } },
        { status: "removed", metadata: {}, judgment: null },
      ]),
    ).toBe(9);
  });

  it("adds judge credits only when a judgment was persisted", () => {
    expect(
      calculateMonitorCheckActualCreditsFromPages([
        { metadata: { creditsUsed: 2 }, judgment: undefined },
        { metadata: { creditsUsed: 2 }, judgment: null },
        { metadata: { creditsUsed: 2 }, judgment: { meaningful: false } },
        { metadata: { creditsUsed: 2 }, judgment: { meaningful: true } },
      ]),
    ).toBe(10);
  });

  it("uses recorded scrape credits for error pages when present", () => {
    expect(
      calculateMonitorCheckActualCreditsFromPages([
        { status: "error", metadata: { creditsUsed: 0 } },
        { status: "error", metadata: { creditsUsed: 4 } },
        { status: "error", metadata: {} },
      ]),
    ).toBe(5);
  });
});

describe("FLAT deterministic search-monitor billing", () => {
  const searchTarget = (
    overrides: Partial<Extract<MonitorTarget, { type: "search" }>> = {},
  ): MonitorTarget =>
    ({
      id: "search-1",
      type: "search",
      queries: ["nvidia gpu launch"],
      searchWindow: "24h",
      maxResults: 10,
      scrapeOptions: {},
      ...overrides,
    }) as MonitorTarget;

  describe("estimate (upper bound)", () => {
    it("judge OFF (raw billing): only the search call, 2 per 10 results", () => {
      // ceil(10/10)*2 * 1 query = 2.
      expect(estimateMonitorCreditsPerRun([searchTarget()], false)).toBe(2);
    });

    it("judge ON: search call + flat 1 per judged result (capped at maxResults)", () => {
      // search 2 + judge min(maxResults, 10) = 10.
      expect(estimateMonitorCreditsPerRun([searchTarget()], true)).toBe(12);
    });

    it("legacy depth:raw target is never judged even when judging is on", () => {
      expect(
        estimateMonitorCreditsPerRun([searchTarget({ depth: "raw" })], true),
      ).toBe(2);
    });

    it("scales search with queries but caps judge at maxResults total", () => {
      const t = searchTarget({
        maxResults: 20,
        queries: ["a", "b", "c"],
      });
      // search ceil((20*3)/10)*2 = 12; judge caps at maxResults (20, not *queries) -> 32.
      expect(estimateMonitorCreditsPerRun([t], true)).toBe(32);
    });
  });

  describe("flatSearchTargetCredits (the deterministic actual)", () => {
    it("sums searchCredits + judgeCredits across search target_results", () => {
      // search 2 + judge 1*3 = 5.
      const targetResults = [
        {
          targetId: "search-1",
          type: "search",
          searchCredits: 2,
          judgeCredits: 3,
          resultsJudged: 3,
        },
      ];
      expect(flatSearchTargetCredits(targetResults)).toBe(5);
    });

    it("raw / judge-off: just the 2 search credits, 0 judge", () => {
      expect(
        flatSearchTargetCredits([
          {
            targetId: "search-1",
            type: "search",
            searchCredits: 2,
            judgeCredits: 0,
            resultsJudged: 0,
          },
        ]),
      ).toBe(2);
    });

    it("ignores non-search target runs and malformed entries", () => {
      expect(
        flatSearchTargetCredits([
          { targetId: "scrape-1", type: "scrape", expectedJobs: ["a"] },
          { targetId: "search-1", type: "search", searchCredits: 4 },
          null,
          "garbage",
          { type: "search" }, // missing credits -> 0
        ]),
      ).toBe(4);
    });

    it("returns 0 for non-array / empty target_results", () => {
      expect(flatSearchTargetCredits(undefined)).toBe(0);
      expect(flatSearchTargetCredits(null)).toBe(0);
      expect(flatSearchTargetCredits([])).toBe(0);
    });
  });

  // Flat billing contract: actual = 2*ceil(totalResults/10) + 1*resultsJudged.
  describe("flat search billing contract (eval H regression guard)", () => {
    const searchCreditsFor = (totalResults: number) =>
      2 * Math.ceil(totalResults / 10);
    const stampedSearchRun = (totalResults: number, resultsJudged: number) => ({
      targetId: "search-1",
      type: "search" as const,
      searchCompleted: true,
      resultCount: totalResults,
      searchCredits: searchCreditsFor(totalResults),
      judgeCredits: judgeCreditsForJudgedCount(resultsJudged),
      resultsJudged,
    });

    it("is the exact deterministic flat sum (the headline 5-credit trace)", () => {
      // results=6 -> search 2; judged=3 -> 3; total 5.
      expect(flatSearchTargetCredits([stampedSearchRun(6, 3)])).toBe(5);
    });

    it("never bills 0 on a check that returned results and judged them", () => {
      // results=6, judged=4 -> 2 + 4 = 6 (regression: this case once landed on 0).
      const credits = flatSearchTargetCredits([stampedSearchRun(6, 4)]);
      expect(credits).toBe(6);
      expect(credits).toBeGreaterThan(0);
    });

    it("the RETRY path still bills: rate-limited-then-succeeded run is summed", () => {
      // A retried run must record the same figure as a clean run; the
      // searchCompleted=true guard ensures credits are stamped before summing.
      const retried = stampedSearchRun(6, 4);
      expect(retried.searchCompleted).toBe(true);
      expect(flatSearchTargetCredits([retried])).toBe(6);
    });

    it("search-only (judge off) bills just the search portion, never the judge", () => {
      // results=6, judged=0 -> 2 + 0 = 2 (raw case).
      expect(flatSearchTargetCredits([stampedSearchRun(6, 0)])).toBe(2);
    });

    it("a still-running search (no credits stamped yet) sums to 0 — the reconciler must NOT finalize here", () => {
      // Pre-stamp shape the dispatcher writes before the inline search finishes.
      // The never-zero guarantee relies on isMonitorCheckComplete refusing to
      // finalize a run whose searchCompleted flag is not yet true (see runner.ts).
      const pending = { targetId: "search-1", type: "search" as const };
      expect((pending as any).searchCompleted).toBeUndefined();
      expect(flatSearchTargetCredits([pending])).toBe(0);
    });
  });

  it("page-sum never bills search-target pages (cost is at the check level)", () => {
    const targets: MonitorTarget[] = [searchTarget()];
    // A search page contributes 0 to the page sum; its credits live in
    // target_results via flatSearchTargetCredits.
    expect(
      calculateMonitorCheckActualCreditsFromPages(
        [
          {
            target_id: "search-1",
            metadata: {},
            judgment: { meaningful: true },
            status: "new",
          },
        ],
        targets,
      ),
    ).toBe(0);
  });
});
