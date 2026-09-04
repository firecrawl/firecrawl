import type { MonitorCheckRow, MonitorRow } from "./types";

vi.mock("../../config", () => ({ config: { USE_DB_AUTHENTICATION: true } }));
vi.mock("../../lib/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { logger };
});
vi.mock("../logging/log_job", () => ({}));
vi.mock("../../lib/gcs-monitoring", () => ({}));
vi.mock("../worker/scrape-worker", () => ({}));
vi.mock("../worker/nuq-router", () => ({}));
vi.mock("./diff", () => ({}));
vi.mock("../../lib/crawl-redis", () => ({}));
vi.mock("../queue-jobs", () => ({}));
vi.mock("../../controllers/v2/types", () => ({}));
vi.mock("../webhook", () => ({}));
vi.mock("./results", () => ({}));
vi.mock("../notification/monitoring_email", () => ({}));
vi.mock("../notification/monitoring_slack", () => ({}));
vi.mock("./types", () => ({}));
vi.mock("./interest", () => ({
  trackMonitorCheckStartedInterest: async () => {},
}));
vi.mock("./search/run", () => ({}));
vi.mock("./search/judge", () => ({}));
vi.mock("./search/dedupe", () => ({}));
vi.mock("./search/persist", () => ({}));
vi.mock("../../scraper/WebScraper/utils/blocklist", () => ({}));
vi.mock("../../controllers/auth", () => ({}));
vi.mock("./store", () => ({
  getMonitorCheckForUpdate: vi.fn(),
  getMonitorForUpdate: vi.fn(),
  listRunningMonitorChecks: vi.fn(),
  updateMonitorCheck: vi.fn(),
  updateMonitorCheckIfRunning: vi.fn(),
  updateMonitorCheckIfStatus: vi.fn(),
  markMonitorRunning: vi.fn(),
  countMonitorCheckPages: vi.fn(),
  calculateMonitorCheckActualCredits: vi.fn(),
  updateMonitorScheduleAfterRun: vi.fn(),
}));
vi.mock("../autumn/autumn.service", () => ({
  autumnService: { finalizeCreditsLock: vi.fn(), lockCredits: vi.fn() },
}));
vi.mock("../queue-service", () => ({ getBillingQueue: vi.fn() }));
vi.mock("../redis", () => ({
  redisEvictConnection: { set: vi.fn(), del: vi.fn(), eval: vi.fn() },
}));

import {
  processMonitorCheckJob,
  reconcileRunningMonitorChecks,
} from "./runner";
import * as store from "./store";
import { autumnService } from "../autumn/autumn.service";
import { getBillingQueue } from "../queue-service";
import { redisEvictConnection } from "../redis";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("monitor check finalization ownership", () => {
  let current: MonitorCheckRow;
  let snapshot: MonitorCheckRow;
  let monitor: MonitorRow;
  const locks = new Map<string, string>();
  const bill = vi.fn();
  const lockKey = "monitor-check-finalize:check-1";

  beforeEach(() => {
    vi.resetAllMocks();
    locks.clear();
    current = {
      id: "check-1",
      monitor_id: "monitor-1",
      team_id: "team-1",
      status: "running",
      billing_status: "reserved",
      autumn_lock_id: "monitor_check-1",
      reserved_credits: 1,
      started_at: new Date().toISOString(),
      target_results: [
        { targetId: "target-1", type: "scrape", expectedJobs: ["scrape-1"] },
      ],
    } as MonitorCheckRow;
    snapshot = structuredClone(current);
    monitor = {
      id: current.monitor_id,
      team_id: current.team_id,
      current_check_id: current.id,
      targets: [
        { id: "target-1", type: "scrape", urls: ["https://example.com"] },
      ],
    } as MonitorRow;
    vi.mocked(store.listRunningMonitorChecks).mockImplementation(async () => [
      structuredClone(snapshot),
    ]);
    vi.mocked(store.getMonitorCheckForUpdate).mockImplementation(async () =>
      structuredClone(current),
    );
    vi.mocked(store.getMonitorForUpdate).mockImplementation(
      async () => monitor,
    );
    vi.mocked(store.updateMonitorCheck).mockImplementation(
      async (_id, patch) => {
        current = { ...current, ...patch };
        return structuredClone(current);
      },
    );
    vi.mocked(store.updateMonitorCheckIfRunning).mockImplementation(
      async (_id, patch) => {
        if (current.status !== "running") return null;
        current = { ...current, ...patch };
        return structuredClone(current);
      },
    );
    vi.mocked(store.updateMonitorCheckIfStatus).mockImplementation(
      async (_id, expectedStatus, patch) => {
        if (current.status !== expectedStatus) return null;
        current = { ...current, ...patch };
        return structuredClone(current);
      },
    );
    vi.mocked(store.countMonitorCheckPages).mockImplementation(
      async ({ status }) => (!status || status === "same" ? 1 : 0),
    );
    vi.mocked(store.calculateMonitorCheckActualCredits).mockResolvedValue(1);
    vi.mocked(autumnService.finalizeCreditsLock).mockResolvedValue(true);
    vi.mocked(getBillingQueue).mockReturnValue({
      add: bill,
    } as unknown as ReturnType<typeof getBillingQueue>);
    vi.mocked(redisEvictConnection.set).mockImplementation((async (
      key: string,
      token: string,
    ) => {
      // Notifications are tested independently; this suite exercises settlement and scheduling.
      if (key.startsWith("monitor-check-notify:")) return null;
      if (locks.has(key)) return null;
      locks.set(key, token);
      return "OK";
    }) as any);
    vi.mocked(redisEvictConnection.del).mockImplementation((async (
      key: string,
    ) => Number(locks.delete(key))) as any);
    vi.mocked(redisEvictConnection.eval).mockImplementation((async (
      _script: string,
      _keys: number,
      key: string,
      token: string,
    ) => {
      if (locks.get(key) !== token) return 0;
      return Number(locks.delete(key));
    }) as any);
  });

  it("settles and schedules a completed check once when another batch retained its running snapshot", async () => {
    await reconcileRunningMonitorChecks();
    await reconcileRunningMonitorChecks();
    expect(current).toMatchObject({
      status: "completed",
      billing_status: "confirmed",
    });
    expect(autumnService.finalizeCreditsLock).toHaveBeenCalledTimes(1);
    expect(autumnService.finalizeCreditsLock).toHaveBeenCalledWith(
      expect.objectContaining({
        lockId: "monitor_check-1",
        action: "confirm",
        overrideValue: 1,
      }),
    );
    expect(bill).toHaveBeenCalledTimes(1);
    expect(store.updateMonitorScheduleAfterRun).toHaveBeenCalledTimes(1);
  });

  it("uses the refreshed target state instead of completing an obsolete snapshot", async () => {
    current.target_results = [
      { type: "search", targetId: "target-1", searchCompleted: false },
    ];
    await reconcileRunningMonitorChecks();
    expect(current.status).toBe("running");
    expect(autumnService.finalizeCreditsLock).not.toHaveBeenCalled();
  });

  it.each(["completed", "partial", "failed"] as const)(
    "leaves an already %s check untouched",
    async status => {
      current.status = status;
      current.billing_status = "confirmed";
      await reconcileRunningMonitorChecks();
      expect(store.updateMonitorCheck).not.toHaveBeenCalled();
      expect(store.updateMonitorCheckIfRunning).not.toHaveBeenCalled();
      expect(autumnService.finalizeCreditsLock).not.toHaveBeenCalled();
    },
  );

  it("skips a deleted check and releases its Redis lock", async () => {
    vi.mocked(store.getMonitorCheckForUpdate).mockResolvedValue(null);
    await reconcileRunningMonitorChecks();
    expect(autumnService.finalizeCreditsLock).not.toHaveBeenCalled();
    expect(locks.has(lockKey)).toBe(false);
  });

  it("allows only one settlement when the Redis lease expires while a worker is still preparing completion", async () => {
    const entered = deferred();
    const resume = deferred();
    vi.mocked(store.calculateMonitorCheckActualCredits).mockImplementationOnce(
      async () => {
        entered.resolve();
        await resume.promise;
        return 1;
      },
    );
    const first = reconcileRunningMonitorChecks();
    await entered.promise;
    locks.delete(lockKey); // The second worker can acquire an expired lease.
    await reconcileRunningMonitorChecks();
    resume.resolve();
    await first;
    expect(autumnService.finalizeCreditsLock).toHaveBeenCalledTimes(1);
    expect(bill).toHaveBeenCalledTimes(1);
    expect(store.updateMonitorScheduleAfterRun).toHaveBeenCalledTimes(1);
    expect(current.billing_status).toBe("confirmed");
  });

  it("does not delete a replacement owner's Redis lock", async () => {
    vi.mocked(store.calculateMonitorCheckActualCredits).mockImplementation(
      async () => {
        locks.set(lockKey, "replacement-owner");
        return 1;
      },
    );
    await reconcileRunningMonitorChecks();
    expect(locks.get(lockKey)).toBe("replacement-owner");
  });

  it.each(["stale", "orphan"])(
    "does not release a %s check whose terminal claim was won by another worker",
    async kind => {
      if (kind === "stale") {
        current.started_at = new Date(
          Date.now() - 2 * 60 * 60 * 1000,
        ).toISOString();
        snapshot = structuredClone(current);
      } else {
        vi.mocked(store.getMonitorForUpdate).mockResolvedValue(null);
      }
      vi.mocked(store.updateMonitorCheckIfRunning).mockImplementation(
        async () => {
          current = {
            ...current,
            status: "completed",
            billing_status: "confirmed",
          };
          return null;
        },
      );
      await reconcileRunningMonitorChecks();
      expect(autumnService.finalizeCreditsLock).not.toHaveBeenCalled();
      expect(store.updateMonitorScheduleAfterRun).not.toHaveBeenCalled();
      expect(current).toMatchObject({
        status: "completed",
        billing_status: "confirmed",
      });
    },
  );

  it("records a failed settlement without enqueueing billing", async () => {
    vi.mocked(autumnService.finalizeCreditsLock).mockResolvedValue(false);
    await reconcileRunningMonitorChecks();
    expect(current).toMatchObject({
      status: "completed",
      billing_status: "failed",
    });
    expect(bill).not.toHaveBeenCalled();
  });

  it.each(["stale", "orphan"])(
    "releases a %s hold after winning the failure transition",
    async kind => {
      if (kind === "stale") {
        current.started_at = new Date(
          Date.now() - 2 * 60 * 60 * 1000,
        ).toISOString();
      } else {
        vi.mocked(store.getMonitorForUpdate).mockResolvedValue(null);
      }
      await reconcileRunningMonitorChecks();
      expect(current).toMatchObject({
        status: "failed",
        billing_status: "released",
      });
      expect(autumnService.finalizeCreditsLock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          action: "release",
          lockId: "monitor_check-1",
        }),
      );
      expect(
        vi.mocked(store.updateMonitorCheckIfRunning).mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(autumnService.finalizeCreditsLock).mock
          .invocationCallOrder[0],
      );
    },
  );

  it("does not reopen a check that became terminal after the job handler read it", async () => {
    const queued = { ...current, status: "queued" as const };
    vi.mocked(store.getMonitorCheckForUpdate).mockResolvedValue(queued);
    current.status = "completed";
    current.billing_status = "confirmed";
    await processMonitorCheckJob({
      checkId: current.id,
      monitorId: monitor.id,
      teamId: monitor.team_id,
    });
    expect(current).toMatchObject({
      status: "completed",
      billing_status: "confirmed",
    });
    expect(store.markMonitorRunning).not.toHaveBeenCalled();
    expect(autumnService.lockCredits).not.toHaveBeenCalled();
  });

  it.each([
    { status: "locked" as const, lockId: "monitor_check-1" },
    { status: "skipped" as const },
    { status: "denied" as const },
  ])(
    "preserves completion when a slow reservation returns $status",
    async result => {
      monitor.targets = [];
      vi.mocked(autumnService.lockCredits).mockImplementation(async () => {
        current = {
          ...current,
          status: "completed",
          billing_status: "confirmed",
        };
        return result;
      });
      await processMonitorCheckJob({
        checkId: current.id,
        monitorId: monitor.id,
        teamId: monitor.team_id,
      });
      expect(current).toMatchObject({
        status: "completed",
        billing_status: "confirmed",
      });
      expect(store.updateMonitorCheck).not.toHaveBeenCalled();
      expect(store.updateMonitorScheduleAfterRun).not.toHaveBeenCalled();
      expect(autumnService.finalizeCreditsLock).not.toHaveBeenCalled();
    },
  );
  it.each([1, 2])(
    "preserves finalized results when target write %i arrives late",
    async lateWrite => {
      monitor.targets = [];
      vi.mocked(autumnService.lockCredits).mockResolvedValue({
        status: "locked",
        lockId: "monitor_check-1",
      });
      const finalizedResults = [
        {
          type: "scrape",
          targetId: "target-1",
          expectedJobs: ["finished-scrape"],
        },
      ];
      let targetWrites = 0;
      const finishBeforeWrite = (patch: Partial<MonitorCheckRow>) => {
        if (patch.target_results && ++targetWrites === lateWrite) {
          current = {
            ...current,
            status: "completed",
            billing_status: "confirmed",
            target_results: finalizedResults,
          };
        }
      };
      const update = vi
        .mocked(store.updateMonitorCheck)
        .getMockImplementation()!;
      const updateIfRunning = vi
        .mocked(store.updateMonitorCheckIfRunning)
        .getMockImplementation()!;
      vi.mocked(store.updateMonitorCheck).mockImplementation(
        async (id, patch) => {
          finishBeforeWrite(patch);
          return update(id, patch);
        },
      );
      vi.mocked(store.updateMonitorCheckIfRunning).mockImplementation(
        async (id, patch) => {
          finishBeforeWrite(patch);
          return updateIfRunning(id, patch);
        },
      );
      await processMonitorCheckJob({
        checkId: current.id,
        monitorId: monitor.id,
        teamId: monitor.team_id,
      });
      expect(current).toMatchObject({
        status: "completed",
        billing_status: "confirmed",
        target_results: finalizedResults,
      });
      expect(targetWrites).toBe(lateWrite);
    },
  );
});
