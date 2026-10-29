import { Client } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../../db/schema";

const state = vi.hoisted(() => ({
  db: undefined as NodePgDatabase | undefined,
  search: false,
  missingMonitor: false,
  bill: vi.fn(),
  finalize: vi.fn(),
  schedule: vi.fn(),
  locks: new Map<string, string>(),
  set: vi.fn(),
  unlock: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../config", () => ({ config: { USE_DB_AUTHENTICATION: true } }));
vi.mock("../../controllers/auth", () => ({}));
vi.mock("../../lib/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: state.warn,
    error: vi.fn(),
    child: (): any => logger,
  };
  return { logger };
});
vi.mock("../../db/connection", () => ({
  get db() {
    return state.db;
  },
  get dbRr() {
    return state.db;
  },
}));
vi.mock("../../db/rpc", () => ({}));
vi.mock("../logging/log_job", () => ({}));
vi.mock("../../lib/gcs-monitoring", () => ({}));
vi.mock("../worker/scrape-worker", () => ({}));
vi.mock("../worker/nuq-router", () => ({}));
vi.mock("./diff", () => ({}));
vi.mock("../../lib/crawl-redis", () => ({}));
vi.mock("../queue-jobs", () => ({}));
vi.mock("../../controllers/v2/types", () => ({
  liftCheckPromptInjection: (options: unknown) => options,
  shouldParsePDF: () => false,
}));
vi.mock("../webhook", () => ({}));
vi.mock("./results", () => ({}));
vi.mock("./types", () => ({}));
vi.mock("../notification/monitoring_email", () => ({}));
vi.mock("../notification/monitoring_slack", () => ({}));
vi.mock("../notification/monitoring_in_app", () => ({}));
vi.mock("./interest", () => ({}));
vi.mock("./search/run", () => ({}));
vi.mock("./search/judge", () => ({}));
vi.mock("./search/dedupe", () => ({}));
vi.mock("./search/persist", () => ({}));
vi.mock("../../scraper/WebScraper/utils/blocklist", () => ({}));
vi.mock("../../lib/team-org", () => ({
  orgIdForTeam: async () => "synthetic-org",
}));
vi.mock("../autumn/autumn.service", () => ({
  autumnService: { finalizeCreditsLock: state.finalize },
}));
vi.mock("../queue-service", () => ({
  getBillingQueue: () => ({ add: state.bill }),
}));
vi.mock("../redis", () => ({
  redisEvictConnection: { set: state.set, eval: state.unlock },
}));
vi.mock("./store", async importOriginal => {
  const actual = await importOriginal<typeof import("./store")>();
  return {
    ...actual,
    listRunningMonitorChecks: vi.fn(actual.listRunningMonitorChecks),
    getMonitorCheckForUpdate: vi.fn(actual.getMonitorCheckForUpdate),
    updateMonitorCheckIfRunning: vi.fn(actual.updateMonitorCheckIfRunning),
    getMonitorForUpdate: async () =>
      state.missingMonitor
        ? null
        : {
            id: monitorId,
            team_id: teamId,
            targets: state.search
              ? [{ id: "target", type: "search", query: "synthetic query" }]
              : [
                  {
                    id: "target",
                    type: "scrape",
                    urls: ["https://example.com"],
                  },
                ],
          },
    updateMonitorScheduleAfterRun: state.schedule,
  };
});

const teamId = "11111111-1111-4111-8111-111111111111";
const monitorId = "22222222-2222-4222-8222-222222222222";
const checkId = (n: number) =>
  `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const databaseUrl = process.env.MONITOR_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "bounded monitor reconciliation with PostgreSQL selection",
  () => {
    let client: Client;
    let reconcile: typeof import("./runner").reconcileRunningMonitorChecks;
    let store: typeof import("./store");
    let now: Date;

    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
      client = new Client({ connectionString: databaseUrl });
      await client.connect();
      state.db = drizzle({ client });
      for (const table of [schema.monitor_checks, schema.monitor_check_pages]) {
        const { name, columns } = getTableConfig(table);
        await client.query(
          `CREATE TEMP TABLE "${name}" (${columns.map(column => `"${column.name}" ${column.getSQLType()}`).join(", ")})`,
        );
      }
      await client.query("CREATE UNIQUE INDEX ON monitor_checks (id)");
      await client.query(
        "CREATE INDEX ON monitor_checks (status, created_at DESC)",
      );
    });

    afterAll(async () => {
      await client?.end();
    });

    beforeEach(async () => {
      vi.resetModules();
      vi.resetAllMocks();
      state.locks.clear();
      state.search = false;
      state.missingMonitor = false;
      now = new Date();
      await client.query("TRUNCATE monitor_checks, monitor_check_pages");
      state.finalize.mockResolvedValue(true);
      state.set.mockImplementation(async (key: string, token: string) => {
        if (key.startsWith("monitor-check-notify:") || state.locks.has(key))
          return null;
        state.locks.set(key, token);
        return "OK";
      });
      state.unlock.mockImplementation(async (_script, _count, key, token) => {
        if (state.locks.get(key) !== token) return 0;
        return Number(state.locks.delete(key));
      });
      store = await import("./store.js");
      const actual = await vi.importActual<typeof import("./store")>("./store");
      vi.mocked(store.listRunningMonitorChecks).mockImplementation(
        actual.listRunningMonitorChecks,
      );
      vi.mocked(store.getMonitorCheckForUpdate).mockImplementation(
        actual.getMonitorCheckForUpdate,
      );
      vi.mocked(store.updateMonitorCheckIfRunning).mockImplementation(
        actual.updateMonitorCheckIfRunning,
      );
      ({ reconcileRunningMonitorChecks: reconcile } = await import(
        "./runner.js"
      ));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function add(
      n: number,
      ready = false,
      createdAt: Date | string = new Date(now.getTime() - 10_000 + n),
    ) {
      await client.query(
        `INSERT INTO monitor_checks
      (id, monitor_id, team_id, status, billing_status, autumn_lock_id, reserved_credits, started_at, created_at, updated_at, target_results)
      VALUES ($1, $2, $3, 'running', 'reserved', $4, 1, $5, $6, $5, $7)`,
        [
          checkId(n),
          monitorId,
          teamId,
          `synthetic-hold-${n}`,
          now.toISOString(),
          typeof createdAt === "string" ? createdAt : createdAt.toISOString(),
          JSON.stringify([
            {
              targetId: "target",
              type: "scrape",
              expectedJobs: [`synthetic-job-${n}`],
            },
          ]),
        ],
      );
      if (ready) await page(n);
    }

    async function page(n: number) {
      await client.query(
        "INSERT INTO monitor_check_pages (id, check_id, target_id, status, metadata) VALUES ($1, $2, 'target', 'new', $3)",
        [checkId(n), checkId(n), JSON.stringify({ creditsUsed: 1 })],
      );
    }

    async function row(n: number) {
      return (
        await client.query(
          "SELECT status, billing_status, actual_credits, created_at, started_at, updated_at FROM monitor_checks WHERE id = $1",
          [checkId(n)],
        )
      ).rows[0];
    }

    function deepCalls() {
      return vi
        .mocked(store.listRunningMonitorChecks)
        .mock.calls.filter(([, page]) => page?.through);
    }

    async function deepBatches() {
      const results = vi.mocked(store.listRunningMonitorChecks).mock.results;
      return Promise.all(
        results
          .filter(
            (_, i) =>
              vi.mocked(store.listRunningMonitorChecks).mock.calls[i][1]
                ?.through,
          )
          .map(result => result.value),
      );
    }

    it("finalizes a younger ready check behind 50 unfinished rows within the bounded tick", async () => {
      for (let n = 1; n <= 51; n++) await add(n, n === 51);
      const before = await client.query(
        "SELECT id, started_at, updated_at, autumn_lock_id FROM monitor_checks WHERE id <> $1 ORDER BY id",
        [checkId(51)],
      );
      await reconcile();
      expect(state.warn.mock.calls).toEqual([]);
      expect(await row(51)).toMatchObject({
        status: "completed",
        billing_status: "confirmed",
        actual_credits: 1,
      });
      expect(store.getMonitorCheckForUpdate).toHaveBeenCalledTimes(51);
      expect(state.finalize).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          action: "confirm",
          overrideValue: 1,
          lockId: "synthetic-hold-51",
        }),
      );
      expect(state.bill).toHaveBeenCalledExactlyOnceWith(
        "bill_team",
        expect.objectContaining({
          credits: 1,
          originating_job_id: checkId(51),
        }),
        expect.objectContaining({ jobId: `monitor-bill-${checkId(51)}` }),
      );
      await reconcile();
      await reconcile();
      expect(state.finalize).toHaveBeenCalledTimes(1);
      expect(state.bill).toHaveBeenCalledTimes(1);
      expect(
        (
          await client.query(
            "SELECT id, started_at, updated_at, autumn_lock_id FROM monitor_checks WHERE id <> $1 ORDER BY id",
            [checkId(51)],
          )
        ).rows,
      ).toEqual(before.rows);
    });
    it("reaches a ready check beyond three full pages with tied timestamps", async () => {
      const tied = new Date(now.getTime() - 10_000);
      for (let n = 351; n >= 1; n--) await add(n, n === 151, tied);
      for (let tick = 1; tick <= 3; tick++) {
        await reconcile();
        expect((await row(151)).status).toBe("running");
      }
      await reconcile();
      expect((await row(151)).status).toBe("completed");
      const batches = await deepBatches();
      expect(batches.map(batch => batch.length)).toEqual([50, 50, 50, 50]);
      expect(batches.flat().map(check => check.id)).toEqual(
        Array.from({ length: 200 }, (_, i) => checkId(i + 1)),
      );
      expect(state.finalize).toHaveBeenCalledTimes(1);
      expect(state.bill).toHaveBeenCalledTimes(1);
    });

    it("does not offset-skip after removals and wraps past continuous newer arrivals", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      for (let n = 1; n <= 301; n++) await add(n, n === 101);
      await reconcile();
      await client.query("DELETE FROM monitor_checks WHERE id <= $1", [
        checkId(50),
      ]);
      await add(0, true, new Date(now.getTime() - 20_000));
      vi.setSystemTime(new Date(now.getTime() + 1_000));
      await add(2000, true, new Date());
      await reconcile();
      expect((await row(101)).status).toBe("running");
      expect((await row(0)).status).toBe("completed");
      vi.setSystemTime(new Date(now.getTime() + 2_000));
      await add(2001, true, new Date());
      await reconcile();
      expect((await row(101)).status).toBe("completed");
      expect((await row(2000)).status).toBe("completed");
      const scans = deepCalls();
      expect(
        scans.every(([, page]) => page!.through === scans[0][1]!.through),
      ).toBe(true);
      expect((await deepBatches())[1][0].id).toBe(checkId(51));
      vi.setSystemTime(new Date(now.getTime() + 3_000));
      await add(2002, true, new Date());
      await reconcile();
      expect((await row(0)).status).toBe("completed");
      await reconcile();
      for (const n of [2000, 2001, 2002])
        expect((await row(n)).status).toBe("completed");
      expect(state.bill).toHaveBeenCalledTimes(5);
    });

    it("bounds all-pending ticks to three queries and 150 deduplicated inspections and wraps", async () => {
      for (let n = 1; n <= 151; n++) await add(n);
      const original = (
        await client.query(
          "SELECT id, started_at, updated_at, autumn_lock_id FROM monitor_checks ORDER BY id",
        )
      ).rows;
      for (let tick = 0; tick < 5; tick++) {
        const queries = vi.mocked(store.listRunningMonitorChecks).mock.calls
          .length;
        const inspections = vi.mocked(store.getMonitorCheckForUpdate).mock.calls
          .length;
        await reconcile();
        expect(store.listRunningMonitorChecks).toHaveBeenCalledTimes(
          queries + 3,
        );
        const attemptedIds = vi
          .mocked(store.getMonitorCheckForUpdate)
          .mock.calls.slice(inspections)
          .map(([, , id]) => id);
        expect(attemptedIds.length).toBeLessThanOrEqual(150);
        expect(new Set(attemptedIds).size).toBe(attemptedIds.length);
      }
      expect((await deepBatches()).map(batch => batch.length)).toEqual([
        50, 50, 50, 1, 50,
      ]);
      expect(state.finalize).not.toHaveBeenCalled();
      expect(state.bill).not.toHaveBeenCalled();
      expect(state.schedule).not.toHaveBeenCalled();
      expect(
        (
          await client.query(
            "SELECT id, started_at, updated_at, autumn_lock_id FROM monitor_checks ORDER BY id",
          )
        ).rows,
      ).toEqual(original);
    });

    it("wraps an exactly full page after one bounded empty tick", async () => {
      for (let n = 1; n <= 50; n++) await add(n);
      await reconcile();
      await reconcile();
      expect(store.getMonitorCheckForUpdate).toHaveBeenCalledTimes(100);
      await page(1);
      await reconcile();
      expect((await row(1)).status).toBe("completed");
      const batches = await deepBatches();
      expect(batches.map(batch => batch.length)).toEqual([50, 0, 50]);
    });

    it("still cleans stale checks before and beyond the unfinished prefix", async () => {
      for (let n = 1; n <= 101; n++) await add(n);
      await client.query(
        "UPDATE monitor_checks SET started_at = $1 WHERE id = ANY($2::uuid[])",
        [
          new Date(now.getTime() - 3_600_001).toISOString(),
          [checkId(1), checkId(101)],
        ],
      );
      await reconcile();
      expect(await row(1)).toMatchObject({
        status: "failed",
        billing_status: "released",
        actual_credits: 0,
      });
      await reconcile();
      await reconcile();
      expect(await row(101)).toMatchObject({
        status: "failed",
        billing_status: "released",
        actual_credits: 0,
      });
      expect(state.finalize).toHaveBeenCalledTimes(2);
      expect(
        state.finalize.mock.calls.every(([call]) => call.action === "release"),
      ).toBe(true);
      expect(state.bill).not.toHaveBeenCalled();
      expect((await row(2)).status).toBe("running");
    });

    it("preserves the sweep cursor on selection failure and releases the process guard", async () => {
      for (let n = 1; n <= 301; n++) await add(n, n === 101);
      await reconcile();
      vi.mocked(store.listRunningMonitorChecks)
        .mockImplementationOnce(async (...args) => {
          const actual =
            await vi.importActual<typeof import("./store")>("./store");
          return actual.listRunningMonitorChecks(...args);
        })
        .mockImplementationOnce(async (...args) => {
          const actual =
            await vi.importActual<typeof import("./store")>("./store");
          return actual.listRunningMonitorChecks(...args);
        })
        .mockRejectedValueOnce(new Error("synthetic selection failure"));
      await expect(reconcile()).rejects.toThrow("synthetic selection failure");
      await reconcile();
      expect(deepCalls()[2]).toEqual(deepCalls()[1]);
      await reconcile();
      expect((await row(101)).status).toBe("completed");
      expect(state.bill).toHaveBeenCalledTimes(1);
    });

    it.each(["set", "unlock"] as const)(
      "advances past a batch %s error and revisits skipped work after wrap",
      async operation => {
        for (let n = 1; n <= 51; n++) await add(n, n === 1 || n === 51);
        state[operation].mockRejectedValueOnce(
          new Error("synthetic lease failure"),
        );
        await expect(reconcile()).rejects.toThrow("synthetic lease failure");
        await reconcile();
        expect((await row(51)).status).toBe("completed");
        state.locks.clear();
        await reconcile();
        expect((await row(1)).status).toBe("completed");
        expect(state.bill).toHaveBeenCalledTimes(2);
      },
    );

    it("skips a contended candidate without mutating its timestamps or hold", async () => {
      await add(1, true);
      const original = await row(1);
      state.locks.set(
        `monitor-check-finalize:${checkId(1)}`,
        "synthetic-other-worker",
      );
      await reconcile();
      expect(await row(1)).toEqual(original);
      expect(store.getMonitorCheckForUpdate).not.toHaveBeenCalled();
      expect(state.finalize).not.toHaveBeenCalled();
      state.locks.clear();
      await reconcile();
      expect((await row(1)).status).toBe("completed");
      expect(state.bill).toHaveBeenCalledTimes(1);
    });

    it("rereads terminal or removed candidates before settling", async () => {
      await add(1, true);
      await add(2, true);
      const actual = await vi.importActual<typeof import("./store")>("./store");
      vi.mocked(store.getMonitorCheckForUpdate).mockImplementation(
        async (team, monitor, id) => {
          if (id === checkId(1))
            await client.query(
              "UPDATE monitor_checks SET status = 'completed', billing_status = 'confirmed' WHERE id = $1",
              [id],
            );
          else
            await client.query("DELETE FROM monitor_checks WHERE id = $1", [
              id,
            ]);
          return actual.getMonitorCheckForUpdate(team, monitor, id);
        },
      );
      await reconcile();
      expect(state.finalize).not.toHaveBeenCalled();
      expect(state.bill).not.toHaveBeenCalled();
      expect(state.schedule).not.toHaveBeenCalled();
      expect((await row(1)).billing_status).toBe("confirmed");
      expect(await row(2)).toBeUndefined();
    });

    it("does not overlap ticks within a process", async () => {
      await add(1, true);
      let resume!: () => void;
      let selected!: () => void;
      const paused = new Promise<void>(resolve => {
        resume = resolve;
      });
      const started = new Promise<void>(resolve => {
        selected = resolve;
      });
      const actual = await vi.importActual<typeof import("./store")>("./store");
      vi.mocked(store.listRunningMonitorChecks).mockImplementationOnce(
        async (...args) => {
          selected();
          await paused;
          return actual.listRunningMonitorChecks(...args);
        },
      );
      const first = reconcile();
      await started;
      await reconcile();
      expect(store.listRunningMonitorChecks).toHaveBeenCalledTimes(2);
      resume();
      await first;
      expect(state.bill).toHaveBeenCalledTimes(1);
    });

    it("waits for a sibling selector after an initial selector error before clearing the process guard", async () => {
      await add(1, true);
      let resume!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>(resolve => {
        resume = resolve;
      });
      const started = new Promise<void>(resolve => {
        entered = resolve;
      });
      const actual = await vi.importActual<typeof import("./store")>("./store");
      vi.mocked(store.listRunningMonitorChecks)
        .mockRejectedValueOnce(new Error("synthetic oldest selector failure"))
        .mockImplementationOnce(async (...args) => {
          entered();
          await paused;
          return actual.listRunningMonitorChecks(...args);
        });
      const first = reconcile();
      const rejection = expect(first).rejects.toThrow(
        "synthetic oldest selector failure",
      );
      await started;
      await new Promise<void>(resolve => setImmediate(resolve));
      await reconcile();
      try {
        expect(store.listRunningMonitorChecks).toHaveBeenCalledTimes(2);
      } finally {
        resume();
        await rejection;
      }
      await reconcile();
      expect(store.listRunningMonitorChecks).toHaveBeenCalledTimes(5);
      expect(state.bill).toHaveBeenCalledTimes(1);
    });

    it("restarts from the oldest prefix after a process restart and progresses on its next tick", async () => {
      for (let n = 1; n <= 301; n++) await add(n, n === 101);
      await reconcile();
      vi.resetModules();
      ({ reconcileRunningMonitorChecks: reconcile } = await import(
        "./runner.js"
      ));
      await reconcile();
      expect((await row(101)).status).toBe("running");
      await reconcile();
      await reconcile();
      expect((await row(101)).status).toBe("completed");
      expect(
        deepCalls()
          .slice(0, 2)
          .every(([, page]) => !page!.after),
      ).toBe(true);
      expect(state.bill).toHaveBeenCalledTimes(1);
    });

    it("finalizes a mid-sweep ready arrival behind 3000 pending rows without reaching the stale horizon", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      await client.query(
        `INSERT INTO monitor_checks
        (id, monitor_id, team_id, status, billing_status, autumn_lock_id, reserved_credits, started_at, created_at, updated_at, target_results)
        SELECT ('33333333-3333-4333-8333-' || LPAD(n::text, 12, '0'))::uuid, $1::uuid, $2::uuid,
          'running', 'reserved', 'synthetic-hold-' || n, 1, $3::timestamptz, $3::timestamptz - interval '10 seconds', $3::timestamptz,
          '[{"targetId":"target","type":"scrape","expectedJobs":["synthetic-job"]}]'::jsonb
        FROM generate_series(1, 3000) AS n`,
        [monitorId, teamId, now.toISOString()],
      );
      await reconcile();
      vi.setSystemTime(new Date(now.getTime() + 60_000));
      await add(3001, true, new Date());
      await client.query(
        "UPDATE monitor_checks SET started_at = $1 WHERE id = $2",
        [new Date().toISOString(), checkId(3001)],
      );
      await reconcile();
      expect(await row(3001)).toMatchObject({
        status: "completed",
        billing_status: "confirmed",
        actual_credits: 1,
      });
      expect(state.finalize).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ action: "confirm" }),
      );
      expect(state.bill).toHaveBeenCalledTimes(1);
      expect(store.listRunningMonitorChecks).toHaveBeenCalledTimes(6);
      expect(
        vi.mocked(store.getMonitorCheckForUpdate).mock.calls.length,
      ).toBeLessThanOrEqual(300);
      expect(
        (
          await client.query(
            "SELECT COUNT(*)::integer AS count FROM monitor_checks WHERE status = 'running' AND started_at = $1 AND updated_at = $1",
            [now.toISOString()],
          )
        ).rows[0].count,
      ).toBe(3000);
    });

    it("interleaves a fresh ready check with an all-stale prefix under a saturated attempt budget", async () => {
      for (let n = 1; n <= 150; n++) await add(n);
      await client.query("UPDATE monitor_checks SET started_at = $1", [
        new Date(now.getTime() - 3_600_001).toISOString(),
      ]);
      await add(1000, true);
      await reconcile();
      expect((await row(1000)).status).toBe("completed");
      expect(store.updateMonitorCheckIfRunning).toHaveBeenCalledTimes(50);
      expect(state.finalize).toHaveBeenCalledTimes(50);
      expect(state.bill).toHaveBeenCalledTimes(1);
      expect(
        state.finalize.mock.calls.filter(([call]) => call.action === "release")
          .length,
      ).toBe(49);
      expect(store.listRunningMonitorChecks).toHaveBeenCalledTimes(3);
      expect(
        vi.mocked(store.getMonitorCheckForUpdate).mock.calls.length,
      ).toBeLessThanOrEqual(150);
    });

    it("services fresh search completions within the ten-minute search stale horizon", async () => {
      state.search = true;
      for (let n = 1; n <= 301; n++) await add(n);
      await reconcile();
      await add(1000);
      await client.query(
        "UPDATE monitor_checks SET target_results = $1 WHERE id = $2",
        [
          JSON.stringify([
            {
              targetId: "target",
              type: "search",
              searchCompleted: true,
              searchCredits: 1,
            },
          ]),
          checkId(1000),
        ],
      );
      await reconcile();
      expect(await row(1000)).toMatchObject({
        status: "completed",
        billing_status: "confirmed",
        actual_credits: 1,
      });
      expect(state.bill).toHaveBeenCalledTimes(1);
      expect(state.finalize).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ action: "confirm", overrideValue: 1 }),
      );
    });

    it("counts orphan releases and refused settlements against the terminal attempt budget", async () => {
      state.missingMonitor = true;
      state.finalize.mockResolvedValue(false);
      for (let n = 1; n <= 200; n++) await add(n);
      await reconcile();
      expect(store.updateMonitorCheckIfRunning).toHaveBeenCalledTimes(50);
      expect(state.finalize).toHaveBeenCalledTimes(50);
      expect(
        state.finalize.mock.calls.every(([call]) => call.action === "release"),
      ).toBe(true);
      expect(state.bill).not.toHaveBeenCalled();
      expect(
        (
          await client.query(
            "SELECT COUNT(*)::integer AS count FROM monitor_checks WHERE status = 'failed' AND billing_status = 'failed'",
          )
        ).rows[0].count,
      ).toBe(50);
    });

    it("uses only two selector queries when no running checks exist", async () => {
      await reconcile();
      expect(store.listRunningMonitorChecks).toHaveBeenCalledTimes(2);
      expect(store.getMonitorCheckForUpdate).not.toHaveBeenCalled();
      expect(store.updateMonitorCheckIfRunning).not.toHaveBeenCalled();
    });

    it("retains budget-skipped deep rows with microsecond precision and duplicate lane membership", async () => {
      const second = new Date(now.getTime() - 10_000)
        .toISOString()
        .slice(0, 19);
      for (let n = 300; n >= 1; n--)
        await add(
          n,
          true,
          `${second}.${String(Math.ceil(n / 2)).padStart(6, "0")}Z`,
        );
      await reconcile();
      expect(store.updateMonitorCheckIfRunning).toHaveBeenCalledTimes(50);
      const firstCalls = vi.mocked(store.getMonitorCheckForUpdate).mock.calls;
      expect(new Set(firstCalls.map(([, , id]) => id)).size).toBe(
        firstCalls.length,
      );
      expect((await row(26)).status).toBe("running");
      await reconcile();
      expect(deepCalls()[1][1]!.after).toMatchObject({ id: checkId(25) });
      expect(deepCalls()[1][1]!.after!.created_at).toContain("000013");
      expect(deepCalls()[0][1]!.through!.created_at).toContain(".00015");
      for (let tick = 2; tick < 6; tick++) {
        const attempts = vi.mocked(store.updateMonitorCheckIfRunning).mock.calls
          .length;
        const queries = vi.mocked(store.listRunningMonitorChecks).mock.calls
          .length;
        await reconcile();
        expect(
          vi.mocked(store.updateMonitorCheckIfRunning).mock.calls.length -
            attempts,
        ).toBeLessThanOrEqual(50);
        expect(
          vi.mocked(store.listRunningMonitorChecks).mock.calls.length - queries,
        ).toBeLessThanOrEqual(3);
      }
      expect(
        (
          await client.query(
            "SELECT COUNT(*)::integer AS count FROM monitor_checks WHERE status = 'completed'",
          )
        ).rows[0].count,
      ).toBe(300);
      expect(state.bill).toHaveBeenCalledTimes(300);
      expect(
        new Set(state.bill.mock.calls.map(([, , options]) => options.jobId))
          .size,
      ).toBe(300);
    });

    it.each(["lose", "throw"] as const)(
      "counts terminal CAS attempts that %s against the action budget",
      async mode => {
        for (let n = 1; n <= 200; n++) await add(n, true);
        vi.mocked(store.updateMonitorCheckIfRunning).mockImplementation(
          async () => {
            if (mode === "throw") throw new Error("synthetic CAS failure");
            return null;
          },
        );
        await reconcile();
        expect(store.updateMonitorCheckIfRunning).toHaveBeenCalledTimes(50);
        expect(state.finalize).not.toHaveBeenCalled();
        expect(state.bill).not.toHaveBeenCalled();
        expect((await row(1)).status).toBe("running");
      },
    );

    it("allows only one real terminal claim across independent processes after lease expiry", async () => {
      await add(1, true);
      const actual = await vi.importActual<typeof import("./store")>("./store");
      let resume!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>(resolve => {
        resume = resolve;
      });
      const started = new Promise<void>(resolve => {
        entered = resolve;
      });
      vi.mocked(store.updateMonitorCheckIfRunning).mockImplementationOnce(
        async (...args) => {
          entered();
          await paused;
          return actual.updateMonitorCheckIfRunning(...args);
        },
      );
      const first = reconcile();
      await started;
      state.locks.clear();
      vi.resetModules();
      const otherProcess = await import("./runner.js");
      await otherProcess.reconcileRunningMonitorChecks();
      resume();
      await first;
      expect(store.updateMonitorCheckIfRunning).toHaveBeenCalledTimes(2);
      expect(state.finalize).toHaveBeenCalledTimes(1);
      expect(state.bill).toHaveBeenCalledTimes(1);
      expect((await row(1)).billing_status).toBe("confirmed");
    });

    it.each([0, -1, 51, 1.5, NaN, Infinity])(
      "rejects an invalid tick budget %s before querying",
      async limit => {
        await expect(reconcile(limit)).rejects.toThrow(RangeError);
        expect(store.listRunningMonitorChecks).not.toHaveBeenCalled();
      },
    );
  },
);
