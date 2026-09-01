import crypto from "crypto";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  TEST_PRODUCTION,
  concurrentIf,
  createTestIdUrl,
  describeIf,
} from "../lib";
import {
  changeTrackingGetLastScrape,
  changeTrackingInsertScrape,
  changeTrackingRowKey,
} from "../../../lib/change-tracking-store";
import { idmux, scrape, scrapeTimeout, Identity } from "./lib";

// ============================================================================
// Store semantics
// ============================================================================

describeIf(TEST_PRODUCTION)("Change tracking store", () => {
  const teamId = () => crypto.randomUUID();

  it.concurrent(
    "writes a scrape and reads back job_id + date_added",
    async () => {
      const team = teamId();
      const dateAdded = new Date("2026-09-01T12:00:00.000Z");
      await changeTrackingInsertScrape({
        team_id: team,
        url: "https://example.com/page",
        job_id: crypto.randomUUID(),
        tag: null,
        date_added: dateAdded,
      });
      const res = await changeTrackingGetLastScrape({
        team_id: team,
        url: "https://example.com/page",
        tag: null,
      });
      expect(res).not.toBeNull();
      expect(res!.job_id).toBeDefined();
      expect(new Date(res!.date_added).getTime()).toBe(dateAdded.getTime());
    },
    30000,
  );

  it.concurrent(
    "newer scrape wins regardless of write order",
    async () => {
      const team = teamId();
      const url = "https://example.com/wins";
      const older = { job: crypto.randomUUID(), at: new Date(1000000000000) };
      const newer = { job: crypto.randomUUID(), at: new Date(2000000000000) };

      await changeTrackingInsertScrape({
        team_id: team,
        url,
        job_id: older.job,
        tag: null,
        date_added: older.at,
      });
      await changeTrackingInsertScrape({
        team_id: team,
        url,
        job_id: newer.job,
        tag: null,
        date_added: newer.at,
      });

      const res = await changeTrackingGetLastScrape({
        team_id: team,
        url,
        tag: null,
      });
      expect(res!.job_id).toBe(newer.job);
      expect(new Date(res!.date_added).getTime()).toBe(newer.at.getTime());
    },
    30000,
  );

  it.concurrent(
    "regressed write is shadowed (older date_added cannot clobber newer)",
    async () => {
      const team = teamId();
      const url = "https://example.com/regressed";
      const newer = { job: crypto.randomUUID(), at: new Date(2000000000000) };
      const older = { job: crypto.randomUUID(), at: new Date(1000000000000) };

      await changeTrackingInsertScrape({
        team_id: team,
        url,
        job_id: newer.job,
        tag: null,
        date_added: newer.at,
      });
      // Arrives last, but stamped earlier: must never become visible.
      await changeTrackingInsertScrape({
        team_id: team,
        url,
        job_id: older.job,
        tag: null,
        date_added: older.at,
      });

      const res = await changeTrackingGetLastScrape({
        team_id: team,
        url,
        tag: null,
      });
      expect(res!.job_id).toBe(newer.job);
    },
    30000,
  );

  it.concurrent(
    "null tag, empty tag and named tag are distinct rows",
    async () => {
      const team = teamId();
      const url = "https://example.com/tags";
      for (const tag of [null, "", "watch"] as const) {
        await changeTrackingInsertScrape({
          team_id: team,
          url,
          job_id: `job-${tag === null ? "null" : tag === "" ? "empty" : tag}`,
          tag,
          date_added: new Date(),
        });
      }

      const resNull = await changeTrackingGetLastScrape({
        team_id: team,
        url,
        tag: null,
      });
      const resEmpty = await changeTrackingGetLastScrape({
        team_id: team,
        url,
        tag: "",
      });
      const resWatch = await changeTrackingGetLastScrape({
        team_id: team,
        url,
        tag: "watch",
      });
      expect(resNull!.job_id).toBe("job-null");
      expect(resEmpty!.job_id).toBe("job-empty");
      expect(resWatch!.job_id).toBe("job-watch");
    },
    30000,
  );

  it.concurrent(
    "teams are isolated from each other",
    async () => {
      const url = "https://example.com/isolated";
      const teamA = teamId();
      const teamB = teamId();
      await changeTrackingInsertScrape({
        team_id: teamA,
        url,
        job_id: "job-a",
        tag: null,
        date_added: new Date(),
      });

      const resB = await changeTrackingGetLastScrape({
        team_id: teamB,
        url,
        tag: null,
      });
      const resA = await changeTrackingGetLastScrape({
        team_id: teamA,
        url,
        tag: null,
      });
      expect(resB).toBeNull();
      expect(resA!.job_id).toBe("job-a");
    },
    30000,
  );

  it.concurrent(
    "missing row returns null",
    async () => {
      const res = await changeTrackingGetLastScrape({
        team_id: teamId(),
        url: "https://example.com/never-scraped",
        tag: null,
      });
      expect(res).toBeNull();
    },
    30000,
  );

  it.concurrent(
    "row key layout is fixed-width and injective",
    async () => {
      const key = changeTrackingRowKey(
        "0b6e6ed2-4d0e-4d8c-8d2f-0a1b2c3d4e5f",
        "https://example.com/page?testId=" + crypto.randomUUID(),
        null,
      );
      expect(key.length).toBe(36 + 32 + 32);
      expect(
        Buffer.compare(
          changeTrackingRowKey("team", "https://example.com", null),
          changeTrackingRowKey("team", "https://example.com", ""),
        ),
      ).not.toBe(0);
      expect(
        Buffer.compare(
          changeTrackingRowKey("team", "https://example.com", "a"),
          changeTrackingRowKey("team", "https://example.com/", "a"),
        ),
      ).not.toBe(0);
    },
    30000,
  );
});

// ============================================================================
// E2E through the scrape pipeline
// ============================================================================

describeIf(ALLOW_TEST_SUITE_WEBSITE && TEST_PRODUCTION)(
  "Change tracking E2E",
  () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "change-tracking-e2e",
        concurrency: 100,
        credits: 1000000,
      });
    }, 10000 + scrapeTimeout);

    concurrentIf(TEST_PRODUCTION)(
      "second scrape of the same url+tag sees the first as previous",
      async () => {
        const url = createTestIdUrl();
        const tag = "snips-change-tracking-test";
        const formats = ["markdown", { type: "changeTracking" as const, tag }];

        const first = await scrape({ url, formats }, identity);
        expect(first.markdown).toBeDefined();
        expect(first.changeTracking).toMatchObject({
          changeStatus: "new",
          previousScrapeAt: null,
        });

        const second = await scrape({ url, formats }, identity);
        expect(second.markdown).toBeDefined();
        expect(second.changeTracking).toBeDefined();
        expect(second.changeTracking!.previousScrapeAt).not.toBeNull();
        expect(["changed", "same"]).toContain(
          second.changeTracking!.changeStatus,
        );
      },
      2 * scrapeTimeout,
    );
  },
);
