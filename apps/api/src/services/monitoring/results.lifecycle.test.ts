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
const redis = vi.hoisted(() => ({
  exists: vi.fn(),
  set: vi.fn(),
  eval: vi.fn(),
}));
const lease = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  signal: { aborted: false },
  TimeoutError: class MonitorCheckFinalizeLeaseTimeoutError extends Error {},
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
  redisEvictConnection: redis,
}));
vi.mock("./diff-orchestrator", () => ({ computeAndPersistPageDiff }));
vi.mock("./page-events", () => ({ derivePageIsMeaningful: vi.fn() }));
vi.mock("./store", () => store);
vi.mock("./finalize-lease", () => ({
  acquireMonitorCheckFinalizeLease: lease.acquire,
  MonitorCheckFinalizeLeaseTimeoutError: lease.TimeoutError,
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
    lease.signal.aborted = false;
    lease.acquire.mockResolvedValue({
      release: lease.release,
      signal: lease.signal,
    });
    store.isMonitorCheckRunning.mockResolvedValue(true);
  });

  afterEach(() => vi.useRealTimers());

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
      .mockResolvedValueOnce({ release: lease.release, signal: lease.signal })
      .mockResolvedValueOnce(null);
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

    expect(store.updateMonitorCheckIfRunning).toHaveBeenCalledTimes(1);
    expect(store.deleteMonitorCheckPages).not.toHaveBeenCalled();
    expect(store.insertMonitorCheckPages).not.toHaveBeenCalled();
    expect(store.upsertMonitorPage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("fails with a typed error when lease contention exceeds the deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(300_001);
    lease.acquire.mockResolvedValue(null);
    store.isMonitorCheckRunning.mockResolvedValue(true);

    const recording = recordMonitorScrapeFailure(
      monitorJob(),
      new Error("failed"),
    );
    await vi.advanceTimersByTimeAsync(250);

    await expect(recording).rejects.toBeInstanceOf(lease.TimeoutError);
  });

  it("propagates lease acquisition infrastructure errors", async () => {
    const failure = new Error("Redis unavailable");
    lease.acquire.mockRejectedValue(failure);

    await expect(
      recordMonitorScrapeFailure(monitorJob(), new Error("failed")),
    ).rejects.toBe(failure);
    expect(store.isMonitorCheckRunning).not.toHaveBeenCalled();
  });

  it("replaces the check page before advancing the baseline under the lease", async () => {
    store.updateMonitorCheckIfRunning.mockResolvedValue({ status: "running" });
    store.getMonitorPage.mockResolvedValue(null);
    store.getMonitorForUpdate.mockResolvedValue({ targets: [] });
    computeAndPersistPageDiff.mockResolvedValue({
      status: "new",
      diffGcsKey: null,
      diffTextBytes: null,
      diffJsonBytes: null,
    });

    await recordMonitorScrapeSuccess(monitorJob(), {});

    expect(store.deleteMonitorCheckPages).toHaveBeenCalledTimes(1);
    expect(store.insertMonitorCheckPages).toHaveBeenCalledTimes(1);
    expect(
      store.deleteMonitorCheckPages.mock.invocationCallOrder[0],
    ).toBeLessThan(store.insertMonitorCheckPages.mock.invocationCallOrder[0]);
    expect(store.upsertMonitorPage).toHaveBeenCalledTimes(1);
    expect(
      store.insertMonitorCheckPages.mock.invocationCallOrder[0],
    ).toBeLessThan(store.upsertMonitorPage.mock.invocationCallOrder[0]);
    expect(lease.release).toHaveBeenCalledTimes(2);
  });

  it("keeps the webhook claim after dispatch", async () => {
    store.updateMonitorCheckIfRunning.mockResolvedValue({ status: "running" });
    store.getMonitorPage.mockResolvedValue(null);
    store.getMonitorForUpdate.mockResolvedValue({
      targets: [],
      webhook: { url: "https://example.com/webhook" },
    });
    computeAndPersistPageDiff.mockResolvedValue({
      status: "new",
      diffGcsKey: null,
      diffTextBytes: null,
      diffJsonBytes: null,
    });
    redis.set.mockResolvedValue("OK");

    await recordMonitorScrapeSuccess(monitorJob(), {});

    expect(send).toHaveBeenCalledTimes(1);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("rolls back its webhook claim when ownership is lost before dispatch", async () => {
    store.updateMonitorCheckIfRunning.mockResolvedValue({ status: "running" });
    store.getMonitorPage.mockResolvedValue(null);
    store.getMonitorForUpdate
      .mockResolvedValueOnce({ targets: [] })
      .mockImplementationOnce(async () => {
        lease.signal.aborted = true;
        return {
          targets: [],
          webhook: { url: "https://example.com/webhook" },
        };
      });
    computeAndPersistPageDiff.mockResolvedValue({
      status: "new",
      diffGcsKey: null,
      diffTextBytes: null,
      diffJsonBytes: null,
    });
    redis.set.mockResolvedValue("OK");

    await recordMonitorScrapeSuccess(monitorJob(), {});

    expect(send).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it("stops before baseline advancement after losing lease ownership", async () => {
    store.updateMonitorCheckIfRunning.mockResolvedValue({ status: "running" });
    store.getMonitorPage.mockResolvedValue(null);
    store.getMonitorForUpdate.mockResolvedValue({ targets: [] });
    store.insertMonitorCheckPages.mockImplementation(async () => {
      lease.signal.aborted = true;
    });
    computeAndPersistPageDiff.mockResolvedValue({
      status: "new",
      diffGcsKey: null,
      diffTextBytes: null,
      diffJsonBytes: null,
    });

    await recordMonitorScrapeSuccess(monitorJob(), {});

    expect(store.deleteMonitorCheckPages).toHaveBeenCalledTimes(1);
    expect(store.insertMonitorCheckPages).toHaveBeenCalledTimes(1);
    expect(store.upsertMonitorPage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledTimes(2);
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
