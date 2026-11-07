import type { Logger } from "winston";
import type { SearchVerdict } from "./judge";
import { canonicalizeUrl } from "./dedupe";

// Mocks live in vi.hoisted() so the hoisted vi.mock factories can reference them.
const { searchMock, scrapeURLMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  scrapeURLMock: vi.fn(),
}));

vi.mock("uuid", () => ({ v7: () => "00000000-0000-7000-8000-000000000000" }));
vi.mock("../../../search/v2", () => ({
  // Tests resolve a bare array; wrap it to match search()'s SearchV2Response shape.
  search: async (...a: unknown[]) => {
    const r = await searchMock(...a);
    return Array.isArray(r) ? { web: r } : r;
  },
}));
vi.mock("./tuning", () => ({
  hasLlmProvider: () => true,
  googleProviderOptions: () => ({}),
}));

import { runSearchTarget } from "./run";

const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const verdict = (over: Partial<SearchVerdict> = {}): SearchVerdict => ({
  relevant: true,
  alertAction: "alert",
  concept: "Firecrawl product launch",
  rationale: "Firecrawl announced a new product today.",
  ...over,
});

function runParams(
  targetOver: Record<string, unknown> = {},
  monitorOver: Record<string, unknown> = {},
) {
  return {
    monitor: {
      id: "mon_1",
      teamId: "team_1",
      goal: "Alert me when Firecrawl launches a new product",
      subject: "Firecrawl",
      judgeEnabled: true,
      ...monitorOver,
    },
    target: {
      id: "tgt_1",
      queries: ["Firecrawl launch"],
      searchWindow: "24h",
      alertMode: "first_match" as const,
      maxResults: 10,
      ...targetOver,
    },
    monitorCheckId: "check-1",
    // Adapt scrapeURLMock's legacy { success, document } shape to ScrapeSearchResult.
    scrapePage: async (...a: unknown[]) => {
      const r = (await scrapeURLMock(...a)) as {
        success?: boolean;
        document?: {
          json: unknown;
          markdown?: string;
          metadata?: { publishedTime?: string; modifiedTime?: string };
        };
      } | null;
      return r && r.success && r.document
        ? {
            json: r.document.json ?? null,
            markdown: r.document.markdown ?? "",
            metadata: r.document.metadata ?? {},
          }
        : null;
    },
    goalVersion: "v1",
    knownPages: new Map(),
    knownEvents: [],
    zeroDataRetention: false,
    logger,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const serpRow = (n: number) => ({
  url: `https://news${n}.example.com/story`,
  title: `Firecrawl launches product ${n}`,
  description: `Firecrawl announced product ${n} today.`,
});

describe("deep mode (scrape every selected candidate)", () => {
  it("scrapes every result up to maxResults (no router gating)", async () => {
    searchMock.mockResolvedValue([serpRow(1), serpRow(2), serpRow(3)]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "watch" }),
        markdown: "prose",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(scrapeURLMock).toHaveBeenCalledTimes(3);
    expect(result.matches).toBe(0);
  });
});

describe("alert boundary (the per-page JSON verdict is the gate)", () => {
  beforeEach(() => {
    searchMock.mockResolvedValue([serpRow(1)]);
  });

  it("a clean alert verdict on a fresh result alerts", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(1);
    expect(result.sources[0].status).toBe("alert");
  });

  it("a watch verdict does not alert", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "watch" }),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(0);
    expect(result.sources[0].status).toBe("watching");
  });

  it("an ignore verdict does not alert", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "ignore" }),
        markdown: "Off-topic prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(0);
    expect(result.sources[0].status).toBe("ignored");
  });
});

describe("event state stamps + judgment on alert pages", () => {
  it("stamps satisfiedAt/alertCount/lastAlertAt and a judgment on the alerting page", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    const alertUpsert = result.pageUpserts.find(u => u.status === "alert")!;
    expect(alertUpsert.metadata.eventAlertCount).toBe(1);
    expect(typeof alertUpsert.metadata.eventSatisfiedAt).toBe("string");
    expect(typeof alertUpsert.metadata.eventLastAlertAt).toBe("string");
    expect(alertUpsert.judgment).toMatchObject({
      meaningful: true,
      confidence: "high",
      reason: "Firecrawl announced a new product today.",
    });
  });

  it("a later alert on a known event (every_new_result) increments alertCount and keeps satisfiedAt", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget({
      ...runParams({ alertMode: "every_new_result" }),
      knownEvents: [
        {
          key: canonicalizeUrl(serpRow(1).url),
          label: "Firecrawl product launch",
          satisfiedAt: "2026-06-01T00:00:00Z",
          alertCount: 2,
        },
      ],
    });
    const alertUpsert = result.pageUpserts.find(u => u.status === "alert")!;
    expect(alertUpsert.metadata.eventAlertCount).toBe(3);
    expect(alertUpsert.metadata.eventSatisfiedAt).toBe("2026-06-01T00:00:00Z");
  });
});

describe("judgeEnabled gates the LLM judge", () => {
  it("judge OFF behaves like raw: no LLM stages, no LLM credits, no concept/rationale", async () => {
    // judgeEnabled=false collapses to raw and skips every LLM stage, even with goal + depth:"deep".
    searchMock.mockResolvedValue([serpRow(1), serpRow(2)]);

    const result = await runSearchTarget(
      runParams({ depth: "deep" }, { judgeEnabled: false }),
    );

    // Raw mode does not scrape.
    expect(scrapeURLMock).not.toHaveBeenCalled();

    // Nothing judged, but search still ran and was billed.
    expect(result.judgeCredits).toBe(0);
    expect(result.resultsJudged).toBe(0);
    expect(result.resultCount).toBe(2);

    // Deterministic searchStatus from dedup, but no LLM concept/rationale.
    for (const upsert of result.pageUpserts) {
      expect(upsert.scraped).toBe(false);
      expect(upsert.metadata.concept).toBeUndefined();
      expect(upsert.metadata.rationale).toBeUndefined();
      expect(upsert.metadata.searchStatus).toBeDefined();
    }
  });

  it("judge OFF with no goal still runs search and returns raw results (no throw)", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);

    const result = await runSearchTarget(
      runParams({ depth: "deep" }, { judgeEnabled: false, goal: null }),
    );

    expect(result.resultCount).toBe(1);
    expect(result.judgeCredits).toBe(0);
    expect(result.resultsJudged).toBe(0);
    expect(scrapeURLMock).not.toHaveBeenCalled();
  });

  it("judge ON with depth:deep scrapes and judges per page", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(
      runParams({ depth: "deep" }, { judgeEnabled: true }),
    );

    expect(scrapeURLMock).toHaveBeenCalled();
    expect(result.matches).toBe(1);
    const alertUpsert = result.pageUpserts.find(u => u.status === "alert")!;
    expect(alertUpsert.metadata.concept).toBeDefined();
  });
});

describe("deep-path scrape failures mark the check degraded (no silent empty)", () => {
  beforeEach(() => {
    searchMock.mockResolvedValue([serpRow(1), serpRow(2)]);
  });

  it("degraded=true when EVERY deep-path scrape fails (judging expected, nothing judged)", async () => {
    scrapeURLMock.mockResolvedValue({ success: false });

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    // 0 judged / 0 alerts but degraded — the false-negative we must surface.
    expect(result.resultsJudged).toBe(0);
    expect(result.matches).toBe(0);
    expect(result.judgeDegraded).toBe(true);
    expect(result.degradedReason).toMatch(/judged|incomplete/i);
    // Non-empty summary so the check never reads as a clean "nothing new".
    expect(result.summary).not.toBe("");
    // Each unscrapeable result is persisted as "skipped" so it surfaces as an
    // error check page instead of silently vanishing.
    const skippedUpserts = result.pageUpserts.filter(
      u => u.status === "skipped",
    );
    expect(skippedUpserts).toHaveLength(2);
    expect(skippedUpserts[0].metadata.searchStatus).toBe("skipped");
    expect(skippedUpserts[0].metadata.judgedThisRun).toBe(false);
  });

  it("degraded=true when scrapes throw", async () => {
    scrapeURLMock.mockRejectedValue(new Error("scrape timed out"));

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    expect(result.resultsJudged).toBe(0);
    expect(result.judgeDegraded).toBe(true);
    expect(result.degradedReason).toMatch(/judged|incomplete/i);
  });

  it("NOT degraded when at least one scrape succeeds and is judged", async () => {
    scrapeURLMock.mockImplementation(({ url }: { url: string }) =>
      url === serpRow(1).url
        ? Promise.resolve({
            success: true,
            document: {
              json: verdict({ alertAction: "ignore" }),
              markdown: "prose",
              metadata: {},
            },
          })
        : Promise.resolve({ success: false }),
    );

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    // One result judged (ignored) is a real evaluation, so NOT degraded even
    // though a sibling scrape failed.
    expect(result.resultsJudged).toBe(1);
    expect(result.judgeDegraded).toBe(false);
    expect(result.degradedReason).toBeNull();
  });

  it("NOT degraded when the judge legitimately ignores every (scraped) result", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "ignore" }),
        markdown: "prose",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    // Everything scraped and was evaluated; judge ignored it all. Normal.
    expect(result.resultsJudged).toBe(2);
    expect(result.matches).toBe(0);
    expect(result.judgeDegraded).toBe(false);
    expect(result.degradedReason).toBeNull();
  });

  it("NOT degraded when search legitimately returns zero results", async () => {
    searchMock.mockResolvedValue([]);

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    expect(result.resultCount).toBe(0);
    expect(result.judgeDegraded).toBe(false);
    expect(result.degradedReason).toBeNull();
    expect(scrapeURLMock).not.toHaveBeenCalled();
    // An empty SERP hedges with a bounded retry (1 initial + 2 quick), so a
    // genuinely empty query concludes fast instead of stalling the check.
    expect(searchMock).toHaveBeenCalledTimes(3);
  });

  it("flags partialScrapeLoss (soft signal, NOT degraded) when most scrapes fail but some judge", async () => {
    searchMock.mockResolvedValue([
      serpRow(1),
      serpRow(2),
      serpRow(3),
      serpRow(4),
    ]);
    // Only result 1 scrapes + judges; 2-4 fail to scrape.
    scrapeURLMock.mockImplementation(({ url }: { url: string }) =>
      url === serpRow(1).url
        ? Promise.resolve({
            success: true,
            document: {
              json: verdict({ alertAction: "ignore" }),
              markdown: "prose",
              metadata: {},
            },
          })
        : Promise.resolve({ success: false }),
    );

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    expect(result.resultsJudged).toBe(1);
    expect(result.scrapeFailures).toBe(3);
    // 3/(1+3) = 0.75 >= 0.5 -> soft partial-loss signal, but a verdict was
    // produced so it is NOT a hard degrade.
    expect(result.partialScrapeLoss).toBe(true);
    expect(result.judgeDegraded).toBe(false);
  });

  it("does NOT flag partialScrapeLoss when every scrape succeeds", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "ignore" }),
        markdown: "prose",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    expect(result.scrapeFailures).toBe(0);
    expect(result.partialScrapeLoss).toBe(false);
  });
});

describe("run time budget (a single check can't wedge the consumer)", () => {
  it("stops waiting on a hung pre-scrape and returns skipped+degraded", async () => {
    vi.useFakeTimers();
    try {
      searchMock.mockResolvedValue([serpRow(1), serpRow(2)]);
      // Scrapes never resolve, so the pre-scrape can't finish on its own.
      scrapeURLMock.mockReturnValue(new Promise(() => {}));

      const pending = runSearchTarget(runParams({ depth: "deep" }));
      // Advance past the 4-minute run budget so the deadline fires.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 1000);
      const result = await pending;

      expect(result.matches).toBe(0);
      expect(result.resultsJudged).toBe(0);
      expect(result.judgeDegraded).toBe(true);
      const skipped = result.pageUpserts.filter(u => u.status === "skipped");
      expect(skipped).toHaveLength(2);
      expect(skipped[0].metadata.searchStatus).toBe("skipped");
    } finally {
      vi.useRealTimers();
    }
  });
});
