import type { Mock } from "vitest";
import { trackMonitorTargetInterest } from "../../lib/tracking";
import {
  getRemovedMonitorTargets,
  trackMonitorCheckStartedInterest,
  trackMonitorConfiguredInterest,
  trackMonitorDeactivatedInterest,
} from "./interest";
import type { MonitorCheckRow, MonitorRow, MonitorTarget } from "./types";

vi.mock("../../lib/tracking", () => ({
  trackMonitorTargetInterest: vi.fn(),
}));

const scrapeTarget: MonitorTarget = {
  id: "scrape-target",
  type: "scrape",
  urls: ["https://example.com/a"],
  scrapeOptions: {},
};

const crawlTarget: MonitorTarget = {
  id: "crawl-target",
  type: "crawl",
  url: "https://example.com/docs",
  crawlOptions: { limit: 50, maxDiscoveryDepth: 2 },
  scrapeOptions: {},
};

const monitor = {
  id: "monitor-1",
  team_id: "team-1",
  status: "active",
  schedule_cron: "0 * * * *",
  schedule_timezone: "UTC",
  targets: [scrapeTarget, crawlTarget],
} as MonitorRow;

describe("monitor interest emit helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (trackMonitorTargetInterest as Mock).mockResolvedValue(undefined);
  });

  it("finds configured targets removed by an update", () => {
    expect(
      getRemovedMonitorTargets({
        before: monitor,
        after: { ...monitor, targets: [crawlTarget] },
      }),
    ).toEqual([scrapeTarget]);
  });

  it("emits configured interest for all monitor targets", async () => {
    await trackMonitorConfiguredInterest({
      monitor,
      intervalMs: 60 * 60 * 1000,
    });

    expect(trackMonitorTargetInterest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "configured",
        teamId: "team-1",
        monitorId: "monitor-1",
        monitorStatus: "active",
        intervalMs: 60 * 60 * 1000,
        targets: [scrapeTarget, crawlTarget],
        zeroDataRetention: false,
      }),
    );
  });

  it("emits deactivated interest for a target subset", async () => {
    await trackMonitorDeactivatedInterest({
      monitor: { ...monitor, status: "paused" },
      targets: [scrapeTarget],
      intervalMs: 60 * 60 * 1000,
    });

    expect(trackMonitorTargetInterest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "deactivated",
        monitorStatus: "paused",
        targets: [scrapeTarget],
      }),
    );
  });

  it("emits check_started interest with a check id", async () => {
    await trackMonitorCheckStartedInterest({
      monitor,
      check: { id: "check-1" } as MonitorCheckRow,
    });

    expect(trackMonitorTargetInterest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "check_started",
        checkId: "check-1",
        intervalMs: 60 * 60 * 1000,
        targets: [scrapeTarget, crawlTarget],
      }),
    );
  });
});
