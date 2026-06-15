vi.mock("uuid", () => ({
  v7: () => "test-uuid-v7",
}));

import {
  estimateActualCredits,
  isMonitorCheckStale,
  MONITOR_CHECK_STALE_TIMEOUT_MS,
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
  });
});
