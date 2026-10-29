vi.mock("uuid", () => ({
  v7: () => "test-uuid-v7",
}));

import {
  estimateActualCredits,
  findCompletedSearchTargetRun,
  isMonitorCheckStale,
  MONITOR_CHECK_STALE_TIMEOUT_MS,
  withFinalizeTimeout,
} from "./runner";

describe("monitoring runner", () => {
  describe("estimateActualCredits", () => {
    it("prefers scrape-reported credits when present", () => {
      expect(estimateActualCredits({ metadata: { creditsUsed: 9 } })).toBe(9);
    });

    it("falls back to one credit when scrape metadata is missing credits", () => {
      expect(estimateActualCredits({ metadata: { numPages: 4 } })).toBe(1);
    });
  });

  describe("isMonitorCheckStale", () => {
    const now = new Date("2026-05-06T12:00:00.000Z");

    it("returns true when a running check is at least 1 hour old", () => {
      expect(
        isMonitorCheckStale(
          {
            started_at: new Date(
              now.getTime() - MONITOR_CHECK_STALE_TIMEOUT_MS,
            ).toISOString(),
            updated_at: now.toISOString(),
            created_at: now.toISOString(),
          },
          now,
        ),
      ).toBe(true);
    });

    it("returns false when a running check is not yet stale", () => {
      expect(
        isMonitorCheckStale(
          {
            started_at: new Date(
              now.getTime() - MONITOR_CHECK_STALE_TIMEOUT_MS + 1,
            ).toISOString(),
            updated_at: now.toISOString(),
            created_at: now.toISOString(),
          },
          now,
        ),
      ).toBe(false);
    });

    it("falls back to updated_at for malformed started_at values", () => {
      expect(
        isMonitorCheckStale(
          {
            started_at: null,
            updated_at: new Date(
              now.getTime() - MONITOR_CHECK_STALE_TIMEOUT_MS,
            ).toISOString(),
            created_at: now.toISOString(),
          },
          now,
        ),
      ).toBe(true);
    });

    it("uses the shorter search timeout when the check has a search target", () => {
      // 11 min: past the 10-min search cutoff, under the 1-hour scrape cutoff.
      const elevenMinAgo = new Date(
        now.getTime() - 11 * 60 * 1000,
      ).toISOString();
      const base = {
        started_at: elevenMinAgo,
        updated_at: now.toISOString(),
        created_at: now.toISOString(),
      };
      expect(
        isMonitorCheckStale(
          { ...base, target_results: [{ type: "scrape", targetId: "t1" }] },
          now,
        ),
      ).toBe(false);
      expect(
        isMonitorCheckStale(
          { ...base, target_results: [{ type: "search", targetId: "t1" }] },
          now,
        ),
      ).toBe(true);
      // Mixed search+crawl keeps the 1-hour timeout: the crawl can legitimately
      // run for many minutes and must not be reaped at 11 minutes.
      expect(
        isMonitorCheckStale(
          {
            ...base,
            target_results: [
              { type: "search", targetId: "t1" },
              { type: "crawl", targetId: "t2" },
            ],
          },
          now,
        ),
      ).toBe(false);
    });
  });
});

// On a re-delivered check, an already-completed search target (searchCompleted)
// must restore persisted figures instead of re-running/re-scraping/re-billing.
describe("findCompletedSearchTargetRun (redelivery idempotency)", () => {
  const completed = {
    type: "search",
    targetId: "t1",
    searchCompleted: true,
    resultCount: 5,
    matches: 2,
    searchCredits: 2,
    judgeCredits: 4,
  };

  it("returns the completed run for a matching, searchCompleted target (skip re-run)", () => {
    const found = findCompletedSearchTargetRun([completed], "t1");
    expect(found).not.toBeNull();
    expect(found).toMatchObject({
      targetId: "t1",
      searchCredits: 2,
      matches: 2,
    });
  });

  it("returns null when the search target has NOT completed (must re-run)", () => {
    expect(
      findCompletedSearchTargetRun(
        [{ type: "search", targetId: "t1", searchCompleted: false }],
        "t1",
      ),
    ).toBeNull();
    // searchCompleted absent entirely
    expect(
      findCompletedSearchTargetRun([{ type: "search", targetId: "t1" }], "t1"),
    ).toBeNull();
  });

  it("returns null when the targetId does not match", () => {
    expect(findCompletedSearchTargetRun([completed], "other")).toBeNull();
  });

  it("ignores non-search completed targets (a finished scrape is not a search run)", () => {
    expect(
      findCompletedSearchTargetRun(
        [{ type: "scrape", targetId: "t1", searchCompleted: true }],
        "t1",
      ),
    ).toBeNull();
  });

  it("picks the right target out of a mixed target_results array", () => {
    const results = [
      { type: "scrape", targetId: "s1" },
      { type: "search", targetId: "t1", searchCompleted: false },
      completed,
      null,
      "garbage",
    ];
    // t1's first (incomplete) entry is filtered by searchCompleted, so the
    // completed t1 entry is the one returned.
    const found = findCompletedSearchTargetRun(results, "t1");
    expect(found).toMatchObject({ searchCredits: 2 });
  });

  it("returns null for non-array / empty / malformed input", () => {
    expect(findCompletedSearchTargetRun(undefined, "t1")).toBeNull();
    expect(findCompletedSearchTargetRun(null, "t1")).toBeNull();
    expect(findCompletedSearchTargetRun([], "t1")).toBeNull();
    expect(findCompletedSearchTargetRun("nope", "t1")).toBeNull();
    expect(findCompletedSearchTargetRun([null, "x", 5], "t1")).toBeNull();
  });
});

describe("withFinalizeTimeout", () => {
  it("resolves with the work result and never aborts on success", async () => {
    let observed: boolean | undefined;
    const result = await withFinalizeTimeout(async signal => {
      observed = signal.aborted;
      return "ok";
    }, "fast work");
    expect(result).toBe("ok");
    expect(observed).toBe(false);
  });

  it("aborts the signal so stalled work stops issuing writes after a timeout", async () => {
    const writes: number[] = [];
    const promise = withFinalizeTimeout(
      async signal => {
        // Simulate a finalize tail that gates each write on the signal: the first
        // write lands, then the timeout fires and the rest must be skipped.
        for (let i = 0; i < 5; i++) {
          if (signal.aborted) return;
          writes.push(i);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      },
      "stalled tail",
      10,
    );

    await expect(promise).rejects.toThrow(/exceeded 10ms/);
    // Let any orphaned iterations run; they must observe the abort and stop.
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(writes).toEqual([0]);
  });
});
