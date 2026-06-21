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
});
