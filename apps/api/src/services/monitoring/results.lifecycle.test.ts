const store = vi.hoisted(() => ({
  deleteMonitorCheckPages: vi.fn(),
  getMonitorForUpdate: vi.fn(),
  getMonitorPage: vi.fn(),
  hashMonitorUrl: vi.fn(() => Buffer.from("hash")),
  insertMonitorCheckPages: vi.fn(),
  isMonitorCheckRunning: vi.fn(),
  updateMonitorCheckIfRunning: vi.fn(),
  upsertMonitorPage: vi.fn(),
}));
const computeAndPersistPageDiff = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const lease = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../../lib/logger", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return { logger };
});
vi.mock("../webhook", () => ({
  createWebhookSender: vi.fn(async () => ({ send })),
  WebhookEvent: { MONITOR_PAGE: "monitor.page" },
}));
vi.mock("../redis", () => ({
  redisEvictConnection: { exists: vi.fn(), set: vi.fn() },
}));
vi.mock("./diff-orchestrator", () => ({ computeAndPersistPageDiff }));
vi.mock("./page-events", () => ({ derivePageIsMeaningful: vi.fn() }));
vi.mock("./store", () => store);
vi.mock("./finalize-lease", () => ({
  acquireMonitorCheckFinalizeLease: lease.acquire,
}));

import {
  recordMonitorScrapeFailure,
  recordMonitorScrapeSuccess,
} from "./results";

function monitorJob() {
  return {
    id: "scrape-1",
    data: {
      mode: "single_urls",
      url: "https://example.com",
      team_id: "team-1",
      monitoring: {
        monitorId: "monitor-1",
        checkId: "check-1",
        targetId: "target-1",
        source: "discovered",
      },
    },
  } as any;
}

describe("monitor result lifecycle guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lease.acquire.mockResolvedValue({ release: lease.release });
    store.isMonitorCheckRunning.mockResolvedValue(true);
  });

  it.each([
    {
      kind: "success",
      record: () => recordMonitorScrapeSuccess(monitorJob(), {}),
    },
    {
      kind: "failure",
      record: () => recordMonitorScrapeFailure(monitorJob(), new Error("late")),
    },
  ])("ignores a late $kind after the check is terminal", async ({ record }) => {
    store.updateMonitorCheckIfRunning.mockResolvedValue(null);

    await record();

    expect(store.updateMonitorCheckIfRunning).toHaveBeenCalledWith(
      "check-1",
      {},
    );
    expect(store.getMonitorPage).not.toHaveBeenCalled();
    expect(computeAndPersistPageDiff).not.toHaveBeenCalled();
    expect(store.deleteMonitorCheckPages).not.toHaveBeenCalled();
    expect(store.insertMonitorCheckPages).not.toHaveBeenCalled();
    expect(store.upsertMonitorPage).not.toHaveBeenCalled();
    expect(store.isMonitorCheckRunning).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not mutate page state when finalization owns the lease", async () => {
    store.updateMonitorCheckIfRunning.mockResolvedValue({ status: "running" });
    lease.acquire
      .mockResolvedValueOnce({ release: lease.release })
      .mockResolvedValueOnce(null);
    store.getMonitorPage.mockResolvedValue(null);
    store.getMonitorForUpdate.mockResolvedValue({ targets: [] });
    computeAndPersistPageDiff.mockResolvedValue({
      status: "new",
      diffGcsKey: null,
      diffTextBytes: null,
      diffJsonBytes: null,
    });

    await recordMonitorScrapeSuccess(monitorJob(), {});

    expect(store.updateMonitorCheckIfRunning).toHaveBeenCalledTimes(1);
    expect(store.deleteMonitorCheckPages).not.toHaveBeenCalled();
    expect(store.insertMonitorCheckPages).not.toHaveBeenCalled();
    expect(store.upsertMonitorPage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks terminal status after acquiring the finalization lease", async () => {
    store.updateMonitorCheckIfRunning.mockResolvedValue({ status: "running" });
    store.isMonitorCheckRunning.mockResolvedValue(false);
    store.getMonitorPage.mockResolvedValue(null);
    store.getMonitorForUpdate.mockResolvedValue({ targets: [] });
    computeAndPersistPageDiff.mockResolvedValue({
      status: "new",
      diffGcsKey: null,
      diffTextBytes: null,
      diffJsonBytes: null,
    });

    await recordMonitorScrapeSuccess(monitorJob(), {});

    expect(store.deleteMonitorCheckPages).not.toHaveBeenCalled();
    expect(store.insertMonitorCheckPages).not.toHaveBeenCalled();
    expect(store.upsertMonitorPage).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });
});
