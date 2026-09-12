import { randomUUID } from "crypto";
import { Pool } from "pg";
import { config } from "../config";
import { nuqShutdown, scrapeQueue } from "../services/worker/nuq";

const describeIf = config.NUQ_DATABASE_URL ? describe : describe.skip;

describeIf("NuQ Postgres queue", () => {
  let cleanupPool: Pool;
  const ids: string[] = [];

  beforeAll(() => {
    cleanupPool = new Pool({
      connectionString: config.NUQ_DATABASE_URL,
      application_name: "nuq-postgres-test",
    });
  });

  afterEach(async () => {
    if (ids.length === 0) return;
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

  function scrapeData() {
    return {
      mode: "single_urls",
      url: "https://example.com",
      team_id: randomUUID(),
    } as any;
  }

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

  // Regression test for https://github.com/firecrawl/firecrawl/issues/4113
  // Postgres rejects JSON containing U+0000 (NUL bytes) with error 22P05.
  // The worker must sanitise the returnvalue before the UPDATE so scraped
  // content with embedded NUL bytes never crash-loops the api container.
  test("jobFinish with NUL bytes in returnvalue does not throw (22P05)", async () => {
    const jobId = randomUUID();
    ids.push(jobId);

    const job = await scrapeQueue.addJob(jobId, scrapeData());
    expect(job).toMatchObject({ id: jobId, status: "waiting" });

    // Lock the job so jobFinish's UPDATE matches
    const locked = await scrapeQueue.getJob(jobId);
    expect(locked).not.toBeNull();

    // Build a returnvalue whose JSON contains a NUL byte — the exact shape
    // that certain PDF parsers (e.g. pdf-parse on Google Sheets exports)
    // produce, which triggered the Postgres 22P05 error.
    const nulReturnvalue = {
      markdown: "\u0000Hello from a broken PDF\u0000",
      metadata: { title: "broken\u0000pdf" },
    };

    // jobFinish must complete without throwing, even with NUL bytes present.
    await expect(
      scrapeQueue.jobFinish(jobId, locked!.lock!, nulReturnvalue),
    ).resolves.not.toThrow();

    // The row must be marked completed and the stored value must be NUL-free.
    const row = await cleanupPool.query(
      "SELECT status, returnvalue FROM nuq.queue_scrape WHERE id = $1",
      [jobId],
    );
    expect(row.rows[0].status).toBe("completed");
    const stored = JSON.stringify(row.rows[0].returnvalue);
    expect(stored).not.toContain("\u0000");
  });
});
