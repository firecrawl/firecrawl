import {
  calculateMonitorCheckActualCredits,
  calculateMonitorCheckActualCreditsPaginated,
  getMonitorTargetPerPageCredits,
} from "./billing";
import type { MonitorTarget } from "./types";

function scrapeTarget(
  id: string,
  formats?: Array<string | Record<string, unknown>>,
): MonitorTarget {
  return {
    id,
    type: "scrape",
    urls: ["https://example.com"],
    scrapeOptions: formats ? { formats } : {},
  };
}

describe("monitor billing helpers", () => {
  describe("getMonitorTargetPerPageCredits", () => {
    it("charges one credit for a base monitor scrape", () => {
      expect(getMonitorTargetPerPageCredits(scrapeTarget("base"))).toBe(1);
    });

    it("charges five credits for json monitor scrapes", () => {
      expect(
        getMonitorTargetPerPageCredits(scrapeTarget("json", ["json"])),
      ).toBe(5);
      expect(
        getMonitorTargetPerPageCredits(
          scrapeTarget("change-tracking-json", [
            { type: "changeTracking", modes: ["json"] },
          ]),
        ),
      ).toBe(5);
    });

    it("charges seven credits for deterministic json monitor scrapes", () => {
      expect(
        getMonitorTargetPerPageCredits(
          scrapeTarget("deterministic", [{ type: "deterministicJson" }]),
        ),
      ).toBe(7);
    });
  });

  describe("calculateMonitorCheckActualCredits", () => {
    it("uses recorded credits when a page has creditsUsed metadata", () => {
      expect(
        calculateMonitorCheckActualCredits({
          targets: [scrapeTarget("base")],
          pages: [
            {
              target_id: "base",
              status: "same",
              metadata: { creditsUsed: 9 },
            },
          ],
        }),
      ).toEqual({ actualCredits: 9, unknownTargetIds: [] });
    });

    it("falls back to target pricing when recorded credits are missing", () => {
      expect(
        calculateMonitorCheckActualCredits({
          targets: [
            scrapeTarget("base"),
            scrapeTarget("json", ["json"]),
            scrapeTarget("deterministic", [{ type: "deterministicJson" }]),
          ],
          pages: [
            { target_id: "base", status: "same" },
            { target_id: "json", status: "changed" },
            { target_id: "deterministic", status: "new" },
          ],
        }),
      ).toEqual({ actualCredits: 13, unknownTargetIds: [] });
    });

    it("does not bill removed pages because no current scrape ran", () => {
      expect(
        calculateMonitorCheckActualCredits({
          targets: [scrapeTarget("json", ["json"])],
          pages: [
            {
              target_id: "json",
              status: "removed",
              metadata: { creditsUsed: 5 },
            },
          ],
        }),
      ).toEqual({ actualCredits: 0, unknownTargetIds: [] });
    });

    it("bills error pages only when recorded credits are explicit", () => {
      expect(
        calculateMonitorCheckActualCredits({
          targets: [scrapeTarget("json", ["json"])],
          pages: [
            { target_id: "json", status: "error" },
            {
              target_id: "json",
              status: "error",
              metadata: { creditsUsed: 1 },
            },
          ],
        }),
      ).toEqual({ actualCredits: 1, unknownTargetIds: [] });
    });

    it("does not bill unknown targets without recorded credits", () => {
      expect(
        calculateMonitorCheckActualCredits({
          targets: [scrapeTarget("known")],
          pages: [
            { target_id: "missing", status: "same" },
            { target_id: "known", status: "same" },
          ],
        }),
      ).toEqual({ actualCredits: 1, unknownTargetIds: ["missing"] });
    });

    it("aggregates all pages across pagination chunks", async () => {
      const pages = [
        { target_id: "json", status: "same" },
        { target_id: "json", status: "changed" },
        { target_id: "base", status: "new" },
        { target_id: "json", status: "removed" },
        { target_id: "missing", status: "same" },
        { target_id: "missing", status: "changed" },
      ];

      await expect(
        calculateMonitorCheckActualCreditsPaginated({
          targets: [scrapeTarget("json", ["json"]), scrapeTarget("base")],
          pageSize: 2,
          loadPages: async ({ limit, skip }) => pages.slice(skip, skip + limit),
        }),
      ).resolves.toEqual({
        actualCredits: 11,
        unknownTargetIds: ["missing"],
      });
    });
  });
});
