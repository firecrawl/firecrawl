import { randomUUID } from "crypto";
import { Pool } from "pg";
import { config } from "../config";
import {
  crawlFinishedQueue,
  crawlGroup,
  getNuQPgOwnerLiveResidue,
  NuQPublicationConflictError,
  nuqShutdown,
  scrapeQueue,
} from "../services/worker/nuq";

const describeIf = config.NUQ_DATABASE_URL ? describe : describe.skip;

describeIf("NuQ Postgres queue", () => {
  let cleanupPool: Pool;
  const ids: string[] = [];
  const groupIds: string[] = [];

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
    await cleanupPool.query(
      "DELETE FROM nuq.queue_crawl_finished WHERE id = ANY($1::uuid[]) OR group_id = ANY($2::uuid[])",
      [ids, groupIds],
    );
    await cleanupPool.query(
      "DELETE FROM nuq.group_crawl WHERE id = ANY($1::uuid[])",
      [groupIds],
    );
    ids.length = 0;
    groupIds.length = 0;
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

  test("stable single publication is idempotent and rejects incompatible reuse", async () => {
    const id = randomUUID();
    const ownerId = randomUUID();
    ids.push(id);
    const data = {
      mode: "single_urls",
      url: "https://example.com/stable",
      team_id: ownerId,
      nested: { b: 2, a: 1 },
      traceContext: { traceparent: "first" },
      concurrencyLimited: true,
      requestedAt: new Date("2026-01-02T03:04:05.000Z"),
      omitted: undefined,
    } as any;

    const first = await scrapeQueue.addJob(id, data, {
      priority: 7,
      ownerId,
    });
    const replay = await scrapeQueue.addJob(
      id,
      {
        ...data,
        nested: { a: 1, b: 2 },
        traceContext: { traceparent: "retry" },
        concurrencyLimited: false,
        requestedAt: "2026-01-02T03:04:05.000Z",
      },
      { priority: 7, ownerId },
    );

    expect(replay).toMatchObject({ id, status: first.status, priority: 7 });
    await expect(
      scrapeQueue.addJob(id, data, { priority: 8, ownerId }),
    ).rejects.toBeInstanceOf(NuQPublicationConflictError);
    expect(await scrapeQueue.getJobs([id])).toHaveLength(1);
  });

  test("UUID casing is canonicalized for stable publication", async () => {
    const id = randomUUID();
    const ownerId = randomUUID();
    ids.push(id);
    const data = { ...scrapeData(), marker: "uuid-casing" };

    const first = await scrapeQueue.addJob(id.toUpperCase(), data, {
      ownerId: ownerId.toUpperCase(),
    });
    const replay = await scrapeQueue.addJob(id, data, { ownerId });

    expect(first.id).toBe(id);
    expect(replay.id).toBe(id);
    expect(await scrapeQueue.getJobs([id])).toHaveLength(1);
  });

  test(
    "bulk publication replays compatible rows across chunk boundaries",
    { timeout: 30_000 },
    async () => {
      const ownerId = randomUUID();
      const jobs = Array.from({ length: 1001 }, (_, index) => ({
        id: randomUUID(),
        data: {
          mode: "single_urls",
          url: `https://example.com/${index}`,
          team_id: ownerId,
        } as any,
        options: { priority: index % 5, ownerId },
      }));
      ids.push(...jobs.map(job => job.id));

      // Simulate a prior bulk attempt that committed its first chunk only.
      await scrapeQueue.addJobs(jobs.slice(0, 1000));
      const published = await scrapeQueue.addJobs(jobs);
      const replayed = await scrapeQueue.addJobs(jobs);

      expect(published.map(job => job.id)).toEqual(jobs.map(job => job.id));
      expect(replayed.map(job => job.id)).toEqual(jobs.map(job => job.id));
      const count = await cleanupPool.query(
        "SELECT count(*)::int AS count FROM nuq.queue_scrape WHERE id = ANY($1::uuid[])",
        [ids],
      );
      expect(count.rows[0].count).toBe(jobs.length);
    },
  );

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

    const addJobIfNotExistsData = scrapeData();
    await expect(
      scrapeQueue.addJobIfNotExists(
        addJobIfNotExistsId,
        addJobIfNotExistsData,
        {
          backlogged: true,
          backloggedTimesOutAt: new Date(Date.now() + 60_000),
        },
      ),
    ).resolves.toMatchObject({
      id: addJobIfNotExistsId,
      status: "backlog",
    });

    const original = await scrapeQueue.getJobsFromBacklog([
      addJobIfNotExistsId,
    ]);
    await expect(
      scrapeQueue.addJobIfNotExists(
        addJobIfNotExistsId,
        addJobIfNotExistsData,
        {
          backlogged: true,
          backloggedTimesOutAt: new Date(Date.now() + 600_000),
        },
      ),
    ).resolves.toBeNull();
    const replayed = await scrapeQueue.getJobsFromBacklog([
      addJobIfNotExistsId,
    ]);
    expect(replayed[0].backloggedTimesOutAt?.valueOf()).toBe(
      original[0].backloggedTimesOutAt?.valueOf(),
    );
  });

  test("backlog publication replay recognizes an already-promoted stable id", async () => {
    const id = randomUUID();
    const ownerId = randomUUID();
    const data = { ...scrapeData(), team_id: ownerId };
    ids.push(id);
    const backlogOptions = {
      ownerId,
      backlogged: true,
      backloggedTimesOutAt: new Date(Date.now() + 60_000),
    };
    await scrapeQueue.addJob(id, data, backlogOptions);
    await expect(
      scrapeQueue.promoteJobFromBacklogOrAdd(id, data, { ownerId }),
    ).resolves.toMatchObject({ id, status: "queued" });
    await expect(
      scrapeQueue.addJob(id, data, backlogOptions),
    ).resolves.toMatchObject({ id, status: "queued" });
  });

  test("removal clears active and backlog tables", async () => {
    const activeId = randomUUID();
    const backlogId = randomUUID();
    ids.push(activeId, backlogId);
    await scrapeQueue.addJob(activeId, scrapeData(), {});
    await scrapeQueue.addJob(backlogId, scrapeData(), {
      backlogged: true,
      backloggedTimesOutAt: new Date(Date.now() + 60_000),
    });

    await expect(scrapeQueue.removeJobs([activeId, backlogId])).resolves.toBe(
      2,
    );
    const residue = await cleanupPool.query(
      `SELECT
         (SELECT count(*)::int FROM nuq.queue_scrape WHERE id = ANY($1::uuid[])) +
         (SELECT count(*)::int FROM nuq.queue_scrape_backlog WHERE id = ANY($1::uuid[])) AS count`,
      [[activeId, backlogId]],
    );
    expect(residue.rows[0].count).toBe(0);
  });

  test("owner residue includes all worker-visible PG control surfaces", async () => {
    const ownerId = randomUUID();
    const groupId = randomUUID();
    const scrapeId = randomUUID();
    const backlogId = randomUUID();
    const finishedId = randomUUID();
    ids.push(scrapeId, backlogId, finishedId);
    groupIds.push(groupId);

    await crawlGroup.addGroup(groupId, ownerId);
    await scrapeQueue.addJob(scrapeId, scrapeData(), { ownerId, groupId });
    await scrapeQueue.addJob(backlogId, scrapeData(), {
      ownerId,
      groupId,
      backlogged: true,
      backloggedTimesOutAt: new Date(Date.now() + 60_000),
    });
    await crawlFinishedQueue.addJob(finishedId, {}, { ownerId, groupId });

    await expect(getNuQPgOwnerLiveResidue(ownerId)).resolves.toEqual({
      scrape: 1,
      backlog: 1,
      groups: 1,
      crawlFinished: 1,
      total: 4,
    });
  });
});
