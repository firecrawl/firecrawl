import { chInsert } from "./clickhouse-client";
import {
  buildMonitorTargetInterestRows,
  trackMonitorTargetInterest,
} from "./tracking";
import type { MonitorTarget } from "../services/monitoring/types";

vi.mock("./clickhouse-client", () => ({
  chInsert: vi.fn(),
}));

const scrapeTarget: MonitorTarget = {
  id: "target-scrape",
  type: "scrape",
  urls: ["https://example.com/b#fragment", "https://example.com/a/"],
  scrapeOptions: {},
};

const crawlTarget: MonitorTarget = {
  id: "target-crawl",
  type: "crawl",
  url: "https://Docs.Example.com/start#section",
  crawlOptions: {
    limit: 250,
    maxDiscoveryDepth: 3,
    includePaths: ["/docs"],
    excludePaths: ["/docs/archive"],
  },
  scrapeOptions: {},
};

const searchTarget: MonitorTarget = {
  id: "target-search",
  type: "search",
  queries: ["firecrawl launch"],
  searchWindow: "24h",
  alertMode: "first_match",
  depth: "deep",
  maxResults: 10,
};

describe("monitor target interest tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds target-grain rows for scrape and crawl monitors", () => {
    const rows = buildMonitorTargetInterestRows({
      eventType: "configured",
      teamId: "team-1",
      monitorId: "monitor-1",
      monitorStatus: "active",
      scheduleCron: "0 * * * *",
      scheduleTimezone: "UTC",
      intervalMs: 60 * 60 * 1000,
      targets: [scrapeTarget, crawlTarget],
      zeroDataRetention: false,
      eventTime: new Date("2026-05-12T15:00:00.000Z"),
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        event_time: "2026-05-12T15:00:00.000Z",
        event_type: "configured",
        team_id: "team-1",
        monitor_id: "monitor-1",
        target_id: "target-scrape",
        target_type: "scrape",
        target_url: null,
        target_domain: null,
        scrape_url_count: 2,
        crawl_limit: null,
        crawl_max_depth: null,
        interval_seconds: 3600,
        runs_per_day: 24,
        frequency_bucket: "hourly",
        is_active: 1,
        estimated_credits_per_run: 2,
      }),
    );
    expect(rows[0].target_signature).toEqual(expect.any(String));
    expect(String(rows[0].target_signature)).toHaveLength(64);

    expect(rows[1]).toEqual(
      expect.objectContaining({
        target_id: "target-crawl",
        target_type: "crawl",
        target_url: "https://Docs.Example.com/start#section",
        target_domain: "docs.example.com",
        scrape_url_count: 0,
        crawl_limit: 250,
        crawl_max_depth: 3,
        estimated_credits_per_run: 250,
      }),
    );
    expect(rows[1].target_signature).toEqual(expect.any(String));
    expect(String(rows[1].target_signature)).toHaveLength(64);
    expect(rows[1].target_signature).not.toBe(rows[0].target_signature);
  });

  it("search target signatures distinguish maxResults and depth", () => {
    const signatureFor = (target: MonitorTarget) =>
      buildMonitorTargetInterestRows({
        eventType: "configured",
        teamId: "team-1",
        monitorId: "monitor-1",
        monitorStatus: "active",
        scheduleCron: "0 * * * *",
        scheduleTimezone: "UTC",
        intervalMs: 60 * 60 * 1000,
        targets: [target],
        zeroDataRetention: false,
      })[0].target_signature;

    const base = signatureFor(searchTarget);
    expect(signatureFor({ ...searchTarget })).toBe(base);
    expect(signatureFor({ ...searchTarget, maxResults: 25 })).not.toBe(base);
    expect(signatureFor({ ...searchTarget, depth: "standard" })).not.toBe(base);
    expect(
      signatureFor({ ...searchTarget, includeDomains: ["firecrawl.dev"] }),
    ).not.toBe(base);
    expect(
      signatureFor({ ...searchTarget, excludeDomains: ["spam.example"] }),
    ).not.toBe(base);
  });

  it("sends rows to the monitor target ClickHouse table", async () => {
    await trackMonitorTargetInterest({
      eventType: "check_started",
      teamId: "team-1",
      monitorId: "monitor-1",
      monitorStatus: "active",
      scheduleCron: "*/30 * * * *",
      scheduleTimezone: "UTC",
      intervalMs: 30 * 60 * 1000,
      targets: [{ ...scrapeTarget, urls: ["https://example.com/page"] }],
      checkId: "check-1",
      zeroDataRetention: false,
      eventTime: new Date("2026-05-12T15:30:00.000Z"),
    });

    expect(chInsert).toHaveBeenCalledWith("monitor_target_interest_events", [
      expect.objectContaining({
        event_type: "check_started",
        check_id: "check-1",
        target_url: "https://example.com/page",
        target_domain: "example.com",
        scrape_url_count: 1,
        interval_seconds: 1800,
        frequency_bucket: "30m",
      }),
    ]);
  });

  it("does not insert monitor interest for zero data retention", async () => {
    await trackMonitorTargetInterest({
      eventType: "configured",
      teamId: "team-1",
      monitorId: "monitor-1",
      monitorStatus: "active",
      scheduleCron: "0 * * * *",
      scheduleTimezone: "UTC",
      intervalMs: 60 * 60 * 1000,
      targets: [scrapeTarget],
      zeroDataRetention: true,
    });

    expect(chInsert).not.toHaveBeenCalled();
  });
});
