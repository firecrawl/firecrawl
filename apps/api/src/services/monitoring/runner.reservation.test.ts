import { AutumnDefaultError } from "autumn-js";
import type { MonitorCheckRow, MonitorRow } from "./types";

const { sdk, channel, logger, bill } = vi.hoisted(() => {
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
  shouldRouteToFirebill: () => false,
  firebillConfigured: () => false,
}));
vi.mock("../autumn/metrics", () => ({
  autumnCustomerGetOrCreateTotal: { inc: vi.fn() },
  autumnEntityCreatedInlineTotal: { inc: vi.fn() },
  billingRouteTotal: { inc: vi.fn() },
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
import { consumeMonitorCheckJobs } from "./queue";
import * as store from "./store";
import { addScrapeJob } from "../queue-jobs";
import { getACUCTeam } from "../../controllers/auth";
import { redisEvictConnection } from "../redis";
import { trackMonitorCheckStartedInterest } from "./interest";
import { runSearchTarget } from "./search/run";
import { config } from "../../config";
import { autumnService } from "../autumn/autumn.service";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function conflict() {
  const body = JSON.stringify({ code: "lock_already_exists" });
  return new AutumnDefaultError("Reservation failed", {
    request: new Request("https://example.com/check"),
    response: new Response(body, { status: 409 }),
    body,
  });
}

describe("direct monitor reservation ownership", () => {
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
    sdk.balances.finalize,
    sdk.track,
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
    sdk.check.mockResolvedValue({ allowed: true });
    sdk.balances.finalize.mockResolvedValue(undefined);
    sdk.customers.getOrCreate.mockResolvedValue({ id: "org-1" });
    sdk.entities.get.mockResolvedValue({ id: "team-1" });
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
    expect(sdk.balances.finalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        lockId: "monitor_check-1",
        action: "confirm",
        overrideValue: credits,
      }),
    );
    expect(sdk.track).not.toHaveBeenCalled();
    if (credits > 0) {
      expect(bill).toHaveBeenCalledExactlyOnceWith(
        "bill_team",
        expect.objectContaining({ credits, autumnTrackInRequest: true }),
        { jobId: "monitor-bill-check-1", priority: 10 },
      );
    } else expect(bill).not.toHaveBeenCalled();
  }

  it.each([false, true])(
    "leaves a live winner untouched with stored hold=%s",
    async stored => {
      const paused = deferred();
      const resume = deferred();
      if (stored) {
        vi.mocked(store.updateMonitorCheckIfRunning)
          .mockImplementationOnce(async (_id, patch) => {
            Object.assign(current, patch);
            return structuredClone(current);
          })
          .mockImplementationOnce(async (_id, patch) => {
            paused.resolve();
            await resume.promise;
            Object.assign(current, patch);
            return structuredClone(current);
          });
      } else {
        sdk.check.mockImplementationOnce(async () => {
          paused.resolve();
          await resume.promise;
          return { allowed: true };
        });
      }
      if (stored) sdk.check.mockResolvedValueOnce({ allowed: true });
      sdk.check.mockRejectedValueOnce(conflict());
      const winner = processMonitorCheckJob(job);
      await paused.promise;
      const before = snapshot();
      try {
        await expect(processMonitorCheckJob(job)).rejects.toMatchObject({
          name: "ExistingCreditsLockError",
          lockId: "monitor_check-1",
        });
        expect(snapshot()).toEqual(before);
      } finally {
        resume.resolve();
        await winner;
      }
      expect(addScrapeJob).toHaveBeenCalledTimes(1);
      await settleWinner();
    },
  );

  it("does not let the queued claimant overwrite a later reservation winner", async () => {
    const reached = deferred();
    const pending = deferred<{ allowed: boolean }>();
    sdk.check
      .mockImplementationOnce(() => {
        reached.resolve();
        return pending.promise;
      })
      .mockResolvedValueOnce({ allowed: true });
    const claimant = processMonitorCheckJob(job);
    const rejected = expect(claimant).rejects.toMatchObject({
      name: "ExistingCreditsLockError",
    });
    await reached.promise;
    await processMonitorCheckJob(job);
    const before = snapshot();
    pending.reject(conflict());
    await rejected;
    expect(snapshot()).toEqual(before);
    expect(addScrapeJob).toHaveBeenCalledTimes(1);
    await settleWinner();
  });

  it("leaves terminal billing untouched when a contender's conflict arrives late", async () => {
    await processMonitorCheckJob(job);
    const reached = deferred();
    const pending = deferred<{ allowed: boolean }>();
    sdk.check.mockImplementationOnce(() => {
      reached.resolve();
      return pending.promise;
    });
    const contender = processMonitorCheckJob(job);
    const rejected = expect(contender).rejects.toMatchObject({
      name: "ExistingCreditsLockError",
    });
    await reached.promise;
    await settleWinner();
    const before = snapshot();
    pending.reject(conflict());
    await rejected;
    expect(snapshot()).toEqual(before);
  });

  it("reconciles a completed persisted search target without redelivery work", async () => {
    current.status = "running";
    current.started_at = new Date().toISOString();
    current.autumn_lock_id = "monitor_check-1";
    current.billing_status = "reserved";
    monitor.targets = [
      { id: "target-1", type: "search" },
    ] as MonitorRow["targets"];
    current.target_results = [
      {
        targetId: "target-1",
        type: "search",
        searchCompleted: true,
        searchCredits: 1,
      },
    ];
    sdk.check.mockRejectedValueOnce(conflict());
    const before = snapshot();
    await expect(processMonitorCheckJob(job)).rejects.toMatchObject({
      name: "ExistingCreditsLockError",
    });
    expect(snapshot()).toEqual(before);
    await settleWinner();
    expect(runSearchTarget).not.toHaveBeenCalled();
    expect(addScrapeJob).not.toHaveBeenCalled();
  });

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
    expect(sdk.check).not.toHaveBeenCalled();
    expect(sdk.balances.finalize).not.toHaveBeenCalled();
    expect(bill).not.toHaveBeenCalled();
  });

  it("dead-letters recovery of an unlinked orphan hold and leaves expiry to the provider", async () => {
    current.status = "running";
    current.started_at = new Date().toISOString();
    const held = new Set<string>();
    sdk.check.mockImplementation(async ({ lock }) => {
      if (held.has(lock.lockId)) throw conflict();
      held.add(lock.lockId);
      return { allowed: true };
    });
    await expect(
      autumnService.lockCredits({
        teamId: job.teamId,
        orgId: "org-1",
        value: 1,
        lockId: "monitor_check-1",
      }),
    ).resolves.toEqual({ status: "locked", lockId: "monitor_check-1" });
    expect(held.has("monitor_check-1")).toBe(true);
    expect(current.autumn_lock_id).toBeNull();
    await consumeMonitorCheckJobs(processMonitorCheckJob);
    const message = { content: Buffer.from(JSON.stringify(job)) };
    const before = snapshot();
    await channel.consume.mock.calls[0][1](message);
    expect(snapshot()).toEqual(before);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledExactlyOnceWith(message, false, false);
    expect(logger.error).toHaveBeenCalledWith(
      "Monitor check job failed",
      expect.objectContaining({
        error: expect.objectContaining({ name: "ExistingCreditsLockError" }),
      }),
    );
    expect(channel.assertExchange).toHaveBeenCalledWith(
      "monitor.checks.dlx",
      "direct",
      { durable: true },
    );
    expect(channel.assertQueue).toHaveBeenCalledWith(
      "monitor.checks",
      expect.objectContaining({
        arguments: expect.objectContaining({
          "x-dead-letter-exchange": "monitor.checks.dlx",
          "x-dead-letter-routing-key": "monitor.checks",
        }),
      }),
    );
    expect(channel.bindQueue).toHaveBeenCalledWith(
      "monitor.checks.dlq",
      "monitor.checks.dlx",
      "monitor.checks",
    );
    current.started_at = new Date(
      Date.now() - 2 * 60 * 60 * 1000,
    ).toISOString();
    await reconcileRunningMonitorChecks();
    expect(current).toMatchObject({
      status: "failed",
      billing_status: "not_applicable",
    });
    expect(sdk.balances.finalize).not.toHaveBeenCalled();
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
      expect(sdk.balances.finalize).not.toHaveBeenCalled();
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
    expect(sdk.check).not.toHaveBeenCalled();
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
    expect(sdk.check).not.toHaveBeenCalled();
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
      expect(sdk.check).not.toHaveBeenCalled();
    },
  );

  it("does not mark a terminal check when a successful reservation arrives late", async () => {
    current.status = "running";
    current.autumn_lock_id = "monitor_check-1";
    current.billing_status = "reserved";
    const reached = deferred();
    const pending = deferred<{ allowed: boolean }>();
    sdk.check.mockImplementationOnce(() => {
      reached.resolve();
      return pending.promise;
    });
    const delivery = processMonitorCheckJob(job);
    await reached.promise;
    current.status = "completed";
    current.billing_status = "confirmed";
    const terminal = structuredClone(current);
    pending.resolve({ allowed: true });
    await delivery;
    expect(current).toEqual(terminal);
    expect(store.markMonitorRunning).not.toHaveBeenCalled();
    expect(trackMonitorCheckStartedInterest).not.toHaveBeenCalled();
    expect(sdk.balances.finalize).not.toHaveBeenCalled();
    expect(addScrapeJob).not.toHaveBeenCalled();
    expect(bill).not.toHaveBeenCalled();
  });

  it("rejects linked orphan recovery and only stale reconciliation releases its hold", async () => {
    current.status = "running";
    current.started_at = new Date().toISOString();
    current.autumn_lock_id = "monitor_check-1";
    current.billing_status = "reserved";
    sdk.check.mockRejectedValueOnce(conflict());
    const before = snapshot();
    await expect(processMonitorCheckJob(job)).rejects.toMatchObject({
      name: "ExistingCreditsLockError",
    });
    expect(snapshot()).toEqual(before);
    current.started_at = new Date(
      Date.now() - 2 * 60 * 60 * 1000,
    ).toISOString();
    await reconcileRunningMonitorChecks();
    expect(current).toMatchObject({
      status: "failed",
      billing_status: "released",
    });
    expect(sdk.balances.finalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ lockId: "monitor_check-1", action: "release" }),
    );
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
    expect(sdk.balances.finalize).toHaveBeenCalledExactlyOnceWith(
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
    expect(sdk.balances.finalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ action: "release", lockId: "monitor_check-1" }),
    );
    expect(addScrapeJob).not.toHaveBeenCalled();
    expect(bill).not.toHaveBeenCalled();
  });
});
