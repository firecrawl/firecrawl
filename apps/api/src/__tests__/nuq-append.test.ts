import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { Pool, type PoolClient } from "pg";
import { config } from "../config";
import { GroupNotActiveError } from "../services/worker/nuq-group-error";

// These admission tests use PostgreSQL; Redis backlog promotion is separate.
vi.mock("../services/worker/redis", () => ({
  nuqRedis: { shutdown: vi.fn() },
}));
import { nuqShutdown, scrapeQueue } from "../services/worker/nuq";

const describeIf = config.NUQ_DATABASE_URL ? describe : describe.skip;
const schema = readFileSync(
  join(__dirname, "../../../nuq-postgres/nuq.sql"),
  "utf8",
);
const finishSQL = schema.match(
  /cron\.schedule\('nuq_group_crawl_finished', '15 seconds', \$\$([\s\S]*?)\$\$\);/,
)![1];

describeIf("batch append PostgreSQL admission", () => {
  const pool = new Pool({ connectionString: config.NUQ_DATABASE_URL });
  const groups: string[] = [];

  afterEach(async () => {
    for (const table of [
      "queue_scrape",
      "queue_scrape_backlog",
      "queue_crawl_finished",
    ]) {
      await pool.query(
        `DELETE FROM nuq.${table} WHERE group_id = ANY($1::uuid[])`,
        [groups],
      );
    }
    await pool.query("DELETE FROM nuq.group_crawl WHERE id = ANY($1::uuid[])", [
      groups,
    ]);
    groups.length = 0;
  });

  afterAll(async () => {
    await pool.end();
    await nuqShutdown();
  });

  async function group(status: string | null = "active") {
    const id = randomUUID();
    groups.push(id);
    if (status !== null) {
      await pool.query(
        "INSERT INTO nuq.group_crawl (id, owner_id, status, ttl) VALUES ($1, $2, $3, 86400000)",
        [id, randomUUID(), status],
      );
    }
    return id;
  }

  function job(groupId: string, backlogged = false) {
    return {
      id: randomUUID(),
      data: {
        mode: "single_urls",
        url: "https://example.com",
        team_id: randomUUID(),
      } as any,
      options: { groupId, backlogged, requireActiveGroup: true },
    };
  }

  test.each(["completed", "cancelled", null])(
    "rejects a %s group without inserting jobs",
    async status => {
      const id = await group(status);
      await expect(
        scrapeQueue.addJobs([job(id), job(id, true)]),
      ).rejects.toBeInstanceOf(GroupNotActiveError);
      const count = await pool.query(
        "SELECT (SELECT count(*) FROM nuq.queue_scrape WHERE group_id = $1) + (SELECT count(*) FROM nuq.queue_scrape_backlog WHERE group_id = $1) AS count",
        [id],
      );
      expect(Number(count.rows[0].count)).toBe(0);
    },
  );

  test("registers regular and backlogged jobs in an active group", async () => {
    const id = await group();
    const jobs = await scrapeQueue.addJobs([job(id), job(id, true)]);
    expect(jobs.map(job => job.status)).toEqual(["queued", "backlog"]);
  });

  test("preserves terminal rejection when rollback fails and discards the client", async () => {
    const id = randomUUID();
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockRejectedValueOnce(new Error("connection lost during rollback")),
      release: vi.fn(),
    };
    const connect = vi
      .spyOn(Pool.prototype, "connect")
      .mockImplementationOnce(() =>
        Promise.resolve(client as unknown as PoolClient),
      );
    try {
      await expect(scrapeQueue.addJobs([job(id)])).rejects.toBeInstanceOf(
        GroupNotActiveError,
      );
      expect(client.release).toHaveBeenCalledWith(true);
    } finally {
      connect.mockRestore();
    }
  });

  test("rejects registration when a concurrent finisher wins the row lock", async () => {
    const id = await group();
    const finisher = await pool.connect();
    const finisherPID = (await finisher.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    let result: Promise<any> | undefined;
    try {
      await finisher.query("BEGIN");
      await finisher.query(
        "UPDATE nuq.group_crawl SET status = 'completed' WHERE id = $1",
        [id],
      );
      result = scrapeQueue.addJobs([job(id)]).then(
        value => ({ value }),
        error => ({ error }),
      );
      await expect
        .poll(
          async () => {
            const rows = await pool.query(
              "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND application_name = 'nuq' AND wait_event_type = 'Lock'",
              [finisherPID],
            );
            return rows.rowCount;
          },
          { timeout: 10_000 },
        )
        .toBe(1);
      await finisher.query("COMMIT");
      expect(await result).toMatchObject({
        error: expect.any(GroupNotActiveError),
      });
    } finally {
      await finisher.query("ROLLBACK");
      await result;
      finisher.release();
    }
  });

  test("a stale finisher cannot complete a group after append commits", async () => {
    const id = await group();
    const appended = job(id);
    const suffix = appended.id.replaceAll("-", "");
    const trigger = `pause_append_${suffix}`;
    const key = parseInt(suffix.slice(0, 7), 16);
    const blocker = await pool.connect();
    const finisher = await pool.connect();
    const blockerPID = (await blocker.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const finisherPID = (await finisher.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    let adding: Promise<any> | undefined;
    let finishing: Promise<any> | undefined;
    try {
      await pool.query(
        `CREATE FUNCTION nuq.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`,
      );
      await pool.query(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON nuq.queue_scrape FOR EACH ROW WHEN (NEW.id = '${appended.id}'::uuid) EXECUTE FUNCTION nuq.${trigger}()`,
      );
      await blocker.query("SELECT pg_advisory_lock($1)", [key]);
      adding = scrapeQueue.addJobs([appended]);
      await expect
        .poll(
          async () => {
            const rows = await pool.query(
              "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND application_name = 'nuq'",
              [blockerPID],
            );
            return rows.rowCount;
          },
          { timeout: 10_000 },
        )
        .toBe(1);

      // The cron statement takes its snapshot before the append is visible,
      // then waits for the group row held by the enqueue transaction.
      finishing = finisher.query(finishSQL);
      await expect
        .poll(
          async () => {
            const result = await pool.query(
              "SELECT cardinality(pg_blocking_pids($1)) AS count",
              [finisherPID],
            );
            return result.rows[0].count;
          },
          { timeout: 10_000 },
        )
        .toBe(1);
      await blocker.query("SELECT pg_advisory_unlock($1)", [key]);
      await adding;
      await finishing;

      const state = await pool.query(
        "SELECT status FROM nuq.group_crawl WHERE id = $1",
        [id],
      );
      expect(state.rows[0].status).toBe("active");
      await pool.query(
        "UPDATE nuq.queue_scrape SET status = 'completed' WHERE id = $1",
        [appended.id],
      );
      await pool.query(finishSQL);
      const completed = await pool.query(
        "SELECT status FROM nuq.group_crawl WHERE id = $1",
        [id],
      );
      expect(completed.rows[0].status).toBe("completed");
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()");
      await Promise.allSettled([adding, finishing].filter(Boolean));
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON nuq.queue_scrape`);
      await pool.query(`DROP FUNCTION IF EXISTS nuq.${trigger}()`);
      blocker.release();
      finisher.release();
    }
  });
});
