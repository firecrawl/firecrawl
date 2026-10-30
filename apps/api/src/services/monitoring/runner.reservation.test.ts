import type { MonitorCheckRow, MonitorRow } from "./types";

const { sdk, firebill, channel, logger, bill } = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return {
    logger,
    bill: vi.fn(),
    firebill: {
      lock: vi.fn(),
      finalize: vi.fn(),
      track: vi.fn(),
      check: vi.fn(),
    },
    sdk: {
      check: vi.fn(),
      track: vi.fn(),
      balances: { finalize: vi.fn() },
      customers: { getOrCreate: vi.fn(), get: vi.fn() },
      entities: { get: vi.fn(), create: vi.fn() },
    },
    channel: {
      assertExchange: vi.fn(),
      assertQueue: vi.fn(),
      bindQueue: vi.fn(),
      prefetch: vi.fn(),
      consume: vi.fn(),
      ack: vi.fn(),
      nack: vi.fn(),
      on: vi.fn(),
    },
  };
});

vi.mock("../../config", () => ({
  config: { USE_DB_AUTHENTICATION: true, NUQ_RABBITMQ_URL: "amqp://test" },
}));
vi.mock("../../lib/logger", () => ({ logger }));
vi.mock("../autumn/client", () => ({ autumnClient: sdk }));
vi.mock("../autumn/firebill", () => ({
  firebillConfigured: () => true,
  firebillLock: firebill.lock,
  firebillFinalize: firebill.finalize,
  firebillTrack: firebill.track,
  firebillCheck: firebill.check,
}));
vi.mock("../../db/connection", () => ({
  dbRr: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  },
}));
vi.mock("../../db/schema", () => ({ partner_provisioned_accounts: {} }));
vi.mock("../logging/log_job", () => ({ logRequest: vi.fn() }));
vi.mock("../../lib/gcs-monitoring", () => ({}));
vi.mock("../worker/scrape-worker", () => ({}));
vi.mock("../worker/nuq-router", () => ({}));
vi.mock("./diff", () => ({
  normalizeMonitorFormats: (formats: unknown) => formats,
}));
vi.mock("../../lib/crawl-redis", () => ({}));
vi.mock("../queue-jobs", () => ({ addScrapeJob: vi.fn() }));
vi.mock("../../controllers/v2/types", () => ({
  scrapeRequestSchema: { parse: (value: unknown) => value },
}));
vi.mock("../webhook", () => ({}));
vi.mock("./results", () => ({}));
vi.mock("../notification/monitoring_email", () => ({
  sendMonitoringEmailSummary: vi.fn(),
}));
vi.mock("../notification/monitoring_slack", () => ({}));
vi.mock("../notification/monitoring_in_app", () => ({
  recordMonitorInAppNotification: vi.fn(),
}));
vi.mock("./types", () => ({ withMarkdownFormat: (value: unknown) => value }));
vi.mock("./interest", () => ({ trackMonitorCheckStartedInterest: vi.fn() }));
vi.mock("./search/run", () => ({ runSearchTarget: vi.fn() }));
vi.mock("./search/judge", () => ({}));
vi.mock("./search/dedupe", () => ({}));
vi.mock("./search/persist", () => ({}));
vi.mock("../../scraper/WebScraper/utils/blocklist", () => ({}));
vi.mock("../../controllers/auth", () => ({ getACUCTeam: vi.fn() }));
vi.mock("./store", () => ({
  getMonitorCheckForUpdate: vi.fn(),
  getMonitorForUpdate: vi.fn(),
  listRunningMonitorChecks: vi.fn(),
  updateMonitorCheck: vi.fn(),
  updateMonitorCheckIfRunning: vi.fn(),
  updateMonitorCheckIfStatus: vi.fn(),
  markMonitorRunning: vi.fn(),
  countMonitorCheckPages: vi.fn(),
  listMonitorCheckPages: vi.fn(),
  calculateMonitorCheckActualCredits: vi.fn(),
  updateMonitorScheduleAfterRun: vi.fn(),
}));
vi.mock("../queue-service", () => ({ getBillingQueue: () => ({ add: bill }) }));
vi.mock("../redis", () => ({
  redisEvictConnection: { set: vi.fn(), eval: vi.fn() },
}));
vi.mock("amqplib", () => ({
  default: {
    connect: async () => ({ createChannel: async () => channel, on: vi.fn() }),
  },
}));

import {
  processMonitorCheckJob,
  reconcileRunningMonitorChecks,
} from "./runner";
import * as store from "./store";
import { addScrapeJob } from "../queue-jobs";
import { getACUCTeam } from "../../controllers/auth";
import { redisEvictConnection } from "../redis";
import { trackMonitorCheckStartedInterest } from "./interest";
import { runSearchTarget } from "./search/run";
import { config } from "../../config";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("monitor reservation ownership", () => {
  let current: MonitorCheckRow;
  let monitor: MonitorRow;
  let recordedPages: Array<{
    checkId: string;
    targetId: string;
    status: "same" | "changed" | "new" | "removed" | "error";
  }>;
  const job = { teamId: "team-1", monitorId: "monitor-1", checkId: "check-1" };
  const effects = [
    store.updateMonitorCheck,
    store.updateMonitorCheckIfRunning,
    store.updateMonitorCheckIfStatus,
    store.markMonitorRunning,
    store.updateMonitorScheduleAfterRun,
    addScrapeJob,
    runSearchTarget,
    trackMonitorCheckStartedInterest,
    firebill.finalize,
    firebill.track,
    bill,
  ];
  const snapshot = () => ({
    row: structuredClone(current),
    calls: effects.map(fn => vi.mocked(fn).mock.calls.length),
  });

  beforeEach(() => {
    vi.resetAllMocks();
    logger.child.mockReturnValue(logger);
    (config as { USE_DB_AUTHENTICATION: boolean }).USE_DB_AUTHENTICATION = true;
    recordedPages = [];
    current = {
      id: "check-1",
      monitor_id: "monitor-1",
      team_id: "team-1",
      status: "queued",
      started_at: null,
      estimated_credits: 1,
      autumn_lock_id: null,
      billing_status: "not_applicable",
      target_results: [],
    } as unknown as MonitorCheckRow;
    monitor = {
      id: "monitor-1",
      team_id: "team-1",
      current_check_id: "check-1",
      targets: [
        { id: "target-1", type: "scrape", urls: ["https://example.com"] },
      ],
    } as MonitorRow;
    vi.mocked(getACUCTeam).mockResolvedValue({ org_id: "org-1" } as any);
    firebill.lock.mockImplementation(async ({ lockId }) => ({
      status: "locked",
      lockId,
    }));
    firebill.finalize.mockResolvedValue(true);
    vi.mocked(trackMonitorCheckStartedInterest).mockResolvedValue(undefined);
    vi.mocked(store.getMonitorForUpdate).mockImplementation(async () =>
      structuredClone(monitor),
    );
    vi.mocked(store.getMonitorCheckForUpdate).mockImplementation(async () =>
      structuredClone(current),
    );
    vi.mocked(store.listRunningMonitorChecks).mockImplementation(async () =>
      current.status === "running" ? [structuredClone(current)] : [],
    );
    vi.mocked(store.updateMonitorCheck).mockImplementation(
      async (_id, patch) => {
        Object.assign(current, patch);
        return structuredClone(current);
      },
    );
    vi.mocked(store.updateMonitorCheckIfRunning).mockImplementation(
      async (_id, patch) => {
        if (current.status !== "running") return null;
        Object.assign(current, patch);
        return structuredClone(current);
      },
    );
    vi.mocked(store.updateMonitorCheckIfStatus).mockImplementation(
      async (_id, status, patch) => {
        if (current.status !== status) return null;
        Object.assign(current, patch);
        return structuredClone(current);
      },
    );
    vi.mocked(store.countMonitorCheckPages).mockImplementation(
      async ({ checkId, targetId, status }) =>
        recordedPages.filter(
          page =>
            page.checkId === checkId &&
            (!targetId || page.targetId === targetId) &&
            (!status || page.status === status),
        ).length,
    );
    vi.mocked(store.calculateMonitorCheckActualCredits).mockResolvedValue(1);
    vi.mocked(store.listMonitorCheckPages).mockResolvedValue([]);
    vi.mocked(redisEvictConnection.set).mockImplementation((async (
      key: string,
    ) => (key.startsWith("monitor-check-notify:") ? null : "OK")) as any);
    vi.mocked(redisEvictConnection.eval).mockResolvedValue(1);
  });

  async function settleWinner(
    credits = 1,
    status: (typeof recordedPages)[number]["status"] = "same",
  ) {
    recordedPages = [{ checkId: current.id, targetId: "target-1", status }];
    vi.mocked(store.calculateMonitorCheckActualCredits).mockResolvedValue(
      credits,
    );
    await reconcileRunningMonitorChecks();
    await reconcileRunningMonitorChecks();
    expect(current).toMatchObject({
      status: status === "error" ? "partial" : "completed",
      billing_status: "confirmed",
      autumn_lock_id: "monitor_check-1",
      total_pages: 1,
      same_count: Number(status === "same"),
      changed_count: Number(status === "changed"),
      new_count: Number(status === "new"),
      removed_count: Number(status === "removed"),
      error_count: Number(status === "error"),
    });
    expect(firebill.finalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        lockId: "monitor_check-1",
        action: "confirm",
        overrideValue: credits,
      }),
    );
    expect(firebill.track).not.toHaveBeenCalled();
    if (credits > 0) {
      expect(bill).toHaveBeenCalledExactlyOnceWith(
        "bill_team",
        expect.objectContaining({ credits, autumnTrackInRequest: true }),
        { jobId: "monitor-bill-check-1", priority: 10 },
      );
    } else expect(bill).not.toHaveBeenCalled();
  }

  it("confirms a successful hold with zero actual credits without a ledger debit", async () => {
    await processMonitorCheckJob(job);
    await settleWinner(0);
  });

  it("preserves exempt execution without a reservation or debit", async () => {
    monitor.team_id = "preview_team";
    vi.mocked(store.calculateMonitorCheckActualCredits).mockResolvedValue(0);
    await processMonitorCheckJob({ ...job, teamId: monitor.team_id });
    recordedPages = [
      { checkId: current.id, targetId: "target-1", status: "same" },
    ];
    await reconcileRunningMonitorChecks();
    expect(current).toMatchObject({
      status: "completed",
      billing_status: "not_applicable",
      autumn_lock_id: null,
    });
    expect(firebill.lock).not.toHaveBeenCalled();
    expect(firebill.finalize).not.toHaveBeenCalled();
    expect(bill).not.toHaveBeenCalled();
  });

  it.each(["same", "changed", "new", "removed", "error"] as const)(
    "settles the winner using recorded %s page counts",
    async status => {
      await processMonitorCheckJob(job);
      recordedPages = [
        { checkId: current.id, targetId: "other-target", status },
      ];
      await reconcileRunningMonitorChecks();
      expect(current.status).toBe("running");
      expect(firebill.finalize).not.toHaveBeenCalled();
      expect(bill).not.toHaveBeenCalled();
      await settleWinner(status === "error" ? 0 : 1, status);
    },
  );

  it("does not reserve a running delivery that became terminal after its initial read", async () => {
    current.status = "running";
    const initial = structuredClone(current);
    current.status = "completed";
    current.billing_status = "confirmed";
    vi.mocked(store.getMonitorCheckForUpdate).mockResolvedValueOnce(initial);
    const before = snapshot();
    await processMonitorCheckJob(job);
    expect(snapshot()).toEqual(before);
    expect(firebill.lock).not.toHaveBeenCalled();
  });

  it("does not fail or release a winner when the admission reread is unavailable", async () => {
    current.status = "running";
    current.started_at = new Date().toISOString();
    current.autumn_lock_id = "monitor_check-1";
    current.billing_status = "reserved";
    const failure = new Error("Primary read unavailable");
    vi.mocked(store.getMonitorCheckForUpdate)
      .mockResolvedValueOnce(structuredClone(current))
      .mockRejectedValueOnce(failure);
    const before = snapshot();
    await expect(processMonitorCheckJob(job)).rejects.toThrow(failure);
    expect(snapshot()).toEqual(before);
    expect(firebill.lock).not.toHaveBeenCalled();
  });

  it.each(["queued", "running"] as const)(
    "does not reserve when a %s delivery completes during org resolution",
    async status => {
      current.status = status;
      const reached = deferred();
      const pending = deferred<any>();
      vi.mocked(getACUCTeam).mockImplementationOnce(() => {
        reached.resolve();
        return pending.promise;
      });
      const delivery = processMonitorCheckJob(job);
      await reached.promise;
      current.status = "completed";
      current.billing_status = "confirmed";
      const before = snapshot();
      pending.resolve({ org_id: "org-1" });
      await delivery;
      expect(snapshot()).toEqual(before);
      expect(firebill.lock).not.toHaveBeenCalled();
    },
  );

  it("does not mark a terminal check when a successful reservation arrives late", async () => {
    current.status = "running";
    current.autumn_lock_id = "monitor_check-1";
    current.billing_status = "reserved";
    const reached = deferred();
    const pending = deferred<{ status: "locked"; lockId: string }>();
    firebill.lock.mockImplementationOnce(() => {
      reached.resolve();
      return pending.promise;
    });
    const delivery = processMonitorCheckJob(job);
    await reached.promise;
    current.status = "completed";
    current.billing_status = "confirmed";
    const terminal = structuredClone(current);
    pending.resolve({ status: "locked", lockId: "monitor_check-1" });
    await delivery;
    expect(current).toEqual(terminal);
    expect(store.markMonitorRunning).not.toHaveBeenCalled();
    expect(trackMonitorCheckStartedInterest).not.toHaveBeenCalled();
    expect(firebill.finalize).not.toHaveBeenCalled();
    expect(addScrapeJob).not.toHaveBeenCalled();
    expect(bill).not.toHaveBeenCalled();
  });

  it("releases a newly acquired unpersisted hold if later admission fails", async () => {
    vi.mocked(store.updateMonitorCheckIfRunning).mockRejectedValueOnce(
      new Error("Admission failed"),
    );
    await expect(processMonitorCheckJob(job)).rejects.toThrow(
      "Admission failed",
    );
    expect(current).toMatchObject({
      status: "failed",
      billing_status: "released",
      autumn_lock_id: null,
    });
    expect(firebill.finalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ action: "release", lockId: "monitor_check-1" }),
    );
    expect(addScrapeJob).not.toHaveBeenCalled();
    expect(bill).not.toHaveBeenCalled();
  });

  it("releases the acquired persisted hold if marking the monitor fails", async () => {
    vi.mocked(store.markMonitorRunning).mockRejectedValueOnce(
      new Error("Admission failed"),
    );
    await expect(processMonitorCheckJob(job)).rejects.toThrow(
      "Admission failed",
    );
    expect(current).toMatchObject({
      status: "failed",
      billing_status: "released",
      autumn_lock_id: "monitor_check-1",
    });
    expect(firebill.finalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ action: "release", lockId: "monitor_check-1" }),
    );
    expect(addScrapeJob).not.toHaveBeenCalled();
    expect(bill).not.toHaveBeenCalled();
  });
});
