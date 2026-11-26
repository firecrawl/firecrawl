import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "../config";
import { scrapeOptions } from "../controllers/v2/types";
import { nuqShutdown, scrapeQueue } from "../services/worker/nuq";
import type { ScrapeJobData } from "../types";

const describeIf = config.NUQ_DATABASE_URL ? describe : describe.skip;

function scrapeData(): ScrapeJobData {
  return {
    mode: "single_urls",
    url: "https://example.com",
    team_id: randomUUID(),
    scrapeOptions: scrapeOptions.parse({}),
    origin: "test",
    apiKeyId: null,
    zeroDataRetention: false,
  };
}

describeIf("NuQ Postgres queue", () => {
  let cleanupPool: Pool;
  const ids: Array<string> = [];

  beforeAll(() => {
    cleanupPool = new Pool({
      connectionString: config.NUQ_DATABASE_URL,
      application_name: "nuq-postgres-test",
    });
  });

  afterEach(async () => {
    if (ids.length === 0) {
      return;
    }
    await cleanupPool.query(
      "DELETE FROM nuq.queue_scrape_backlog WHERE id = ANY($1::uuid[])",
      [ids],
    );
    await cleanupPool.query(
      "DELETE FROM nuq.queue_scrape WHERE id = ANY($1::uuid[])",
      [ids],
    );
    ids.length = 0;
  });

  afterAll(async () => {
    await cleanupPool.end();
    await nuqShutdown();
  });

  test("single backlogged inserts report backlog status", async () => {
    const addJobId = randomUUID();
    const addJobIfNotExistsId = randomUUID();
    ids.push(addJobId, addJobIfNotExistsId);

    await expect(
      scrapeQueue.addJob(addJobId, scrapeData(), {
        backlogged: true,
        backloggedTimesOutAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toMatchObject({
      id: addJobId,
      status: "backlog",
    });

    await expect(
      scrapeQueue.addJobIfNotExists(addJobIfNotExistsId, scrapeData(), {
        backlogged: true,
        backloggedTimesOutAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toMatchObject({
      id: addJobIfNotExistsId,
      status: "backlog",
    });

    await expect(
      scrapeQueue.addJobIfNotExists(addJobIfNotExistsId, scrapeData(), {
        backlogged: true,
        backloggedTimesOutAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBeNull();
  });

  test("getGroupJobs filters and paginates terminal jobs with payloads", async () => {
    const groupId = randomUUID();
    const completedIds = [randomUUID(), randomUUID()];
    const failedIds = [randomUUID(), randomUUID()];
    ids.push(...completedIds, ...failedIds);

    const base = Date.now() - 10_000;
    const rows = [
      {
        id: completedIds[0],
        status: "completed",
        finishedAt: new Date(base + 1000),
        data: { mode: "single_urls", url: "https://example.com/completed-1" },
        returnvalue: { ok: 1 },
        failedReason: null,
      },
      {
        id: failedIds[0],
        status: "failed",
        finishedAt: new Date(base + 2000),
        data: { mode: "single_urls", url: "https://example.com/failed-1" },
        returnvalue: null,
        failedReason: "failure-1",
      },
      {
        id: completedIds[1],
        status: "completed",
        finishedAt: new Date(base + 3000),
        data: { mode: "single_urls", url: "https://example.com/completed-2" },
        returnvalue: { ok: 2 },
        failedReason: null,
      },
      {
        id: failedIds[1],
        status: "failed",
        finishedAt: new Date(base + 4000),
        data: { mode: "single_urls", url: "https://example.com/failed-2" },
        returnvalue: null,
        failedReason: "failure-2",
      },
    ];

    for (const row of rows) {
      await cleanupPool.query(
        `INSERT INTO nuq.queue_scrape
          (id, group_id, status, data, finished_at, returnvalue, failedreason)
         VALUES ($1, $2, $3::nuq.job_status, $4::jsonb, $5, $6::jsonb, $7)`,
        [
          row.id,
          groupId,
          row.status,
          row.data,
          row.finishedAt,
          row.returnvalue,
          row.failedReason,
        ],
      );
    }

    const completed = await scrapeQueue.getGroupJobs(
      groupId,
      "completed",
      1,
      1,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      id: completedIds[1],
      data: { url: "https://example.com/completed-2" },
      returnvalue: { ok: 2 },
    });

    const failed = await scrapeQueue.getGroupJobs(groupId, "failed");
    const expectedFailed = rows
      .filter(row => row.status === "failed")
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(
      failed.map(job => ({
        id: job.id,
        failedReason: job.failedReason,
        url: "url" in job.data ? job.data.url : undefined,
      })),
    ).toEqual(
      expectedFailed.map(row => ({
        id: row.id,
        failedReason: row.failedReason,
        url: row.data.url,
      })),
    );
  });
});
