import { randomUUID } from "crypto";
import { vi } from "vitest";

const isolation = vi.hoisted(() => ({
  abTestJob: vi.fn(),
  getCrawl: vi.fn(),
}));

vi.mock("../../controllers/auth", () => ({
  getACUCTeam: vi.fn(async () => ({ flags: { nuqFdb: false } })),
}));
vi.mock("../../lib/deployment", () => ({ isSelfHosted: vi.fn(() => false) }));
// Queue publication depends on crawl/scraper helpers only for unrelated crawl
// and A/B paths. Keep those boundaries out of this real PG + Redis + FDB suite;
// in particular, core CI intentionally installs without native scraper builds.
vi.mock("../../lib/crawl-redis", () => ({ getCrawl: isolation.getCrawl }));
vi.mock("../../services/ab-test", () => ({
  abTestJob: isolation.abTestJob,
}));

import { config } from "../../config";
import {
  finalizeConcurrencyLimitActiveJobRollback,
  getConcurrencyLimitActiveJobsCount,
  getConcurrencyRollbackCleanupBacklog,
  recoverConcurrencyLimitRollbacks,
  removeConcurrencyLimitActiveJob,
  reserveConcurrencyLimitActiveJob,
  rollbackConcurrencyLimitActiveJob,
} from "../../lib/concurrency-redis";
import { _addScrapeJobToBullMQ, addScrapeJob } from "../../services/queue-jobs";
import { getRedisConnection } from "../../services/queue-service";
import { redisEvictConnection } from "../../services/redis";
import {
  crawlFinishedQueueFdb,
  crawlGroupFdb,
  externalSlotMigrationObjectId,
  externalSlotsFdb,
  getNuqFdbSweeper,
  NuqFdbPgJobRemovalConflictError,
  nuqFdbMigrationStore,
  pgJobRemovalsFdb,
  scrapeQueueFdb,
} from "../../services/worker/nuq-fdb";
import { TIME_BUCKETS } from "../../services/worker/nuq-fdb/keyspace";
import { getNuqFdbDatabase } from "../../services/worker/nuq-fdb/client";
import {
  NuQGroupPublicationConflictError,
  NuQPublicationConflictError,
  crawlGroup as crawlGroupPg,
  nuqShutdown,
  scrapeQueue as scrapeQueuePg,
} from "../../services/worker/nuq";
import {
  crawlGroup as routedCrawlGroup,
  isFdbTeam,
  mirrorExternalSlotAcquire,
  mirrorExternalSlotRelease,
  renewExternalSlot,
  reserveExternalSlot,
  scrapeQueue as routedScrapeQueue,
} from "../../services/worker/nuq-router";
import { clearMigrationTestTeams } from "./migration-test-cleanup";

const describeIf =
  config.FDB_CLUSTER_FILE && config.NUQ_DATABASE_URL ? describe : describe.skip;
const previousBackend = config.NUQ_BACKEND;
const previousMetricsActivation = config.NUQ_FDB_METRICS_V2_ACTIVATE;

async function makeMetricsReady(): Promise<void> {
  for (const queue of [scrapeQueueFdb, crawlFinishedQueueFdb]) {
    await queue.beginMetricCounterBackfill();
    while (!(await queue.backfillMetricCounts(100))) {
      // bounded pages
    }
  }
  while (!(await crawlGroupFdb.backfillLegacyOwnerIndex(100))) {
    // bounded pages
  }
}

async function clearMigrationTeam(teamId: string): Promise<void> {
  await clearMigrationTestTeams([teamId]);
}

describeIf("NuQ PG publication with durable FDB authority", () => {
  const teamId = randomUUID();
  const jobId = randomUUID();
  const conflictTeamId = randomUUID();
  const conflictJobId = randomUUID();
  const groupTeamId = randomUUID();
  const ambiguousGroupTeamId = randomUUID();
  const conflictGroupTeamId = randomUUID();
  const externalTeamId = randomUUID();
  const capacityTeamId = randomUUID();

  beforeAll(async () => {
    config.NUQ_BACKEND = "pg";
    config.NUQ_FDB_METRICS_V2_ACTIVATE = true;
    await makeMetricsReady();
    await getRedisConnection().del(
      `concurrency-limiter:${teamId}`,
      `nuq:pg-reservation:team:${teamId}:${jobId}`,
      `nuq:job_backend:${jobId}`,
      `concurrency-limiter:${conflictTeamId}`,
      `nuq:pg-reservation:team:${conflictTeamId}:${conflictJobId}`,
      `concurrency-limiter:${capacityTeamId}`,
    );
    await redisEvictConnection.del(`nuq:job_backend:${jobId}`);
  });

  afterAll(async () => {
    await Promise.all([
      scrapeQueuePg.removeJob(jobId).catch(() => undefined),
      scrapeQueuePg.removeJob(conflictJobId).catch(() => undefined),
    ]);
    await getRedisConnection().del(
      `concurrency-limiter:${teamId}`,
      `nuq:pg-reservation:team:${teamId}:${jobId}`,
      `nuq:job_backend:${jobId}`,
      `concurrency-limiter:${conflictTeamId}`,
      `nuq:pg-reservation:team:${conflictTeamId}:${conflictJobId}`,
      `concurrency-limiter:${capacityTeamId}`,
    );
    await redisEvictConnection.del(`nuq:job_backend:${jobId}`);
    await Promise.all([
      clearMigrationTeam(teamId),
      clearMigrationTeam(conflictTeamId),
      clearMigrationTeam(groupTeamId),
      clearMigrationTeam(ambiguousGroupTeamId),
      clearMigrationTeam(conflictGroupTeamId),
      clearMigrationTeam(externalTeamId),
    ]);
    config.NUQ_BACKEND = previousBackend;
    config.NUQ_FDB_METRICS_V2_ACTIVATE = previousMetricsActivation;
    await nuqShutdown();
  });

  test("concurrent Redis holder reservations serialize at the team limit", async () => {
    const holders = Array.from({ length: 32 }, () => randomUUID());
    const results = await Promise.all(
      holders.map(holder =>
        reserveConcurrencyLimitActiveJob(capacityTeamId, holder, 3, 30_000),
      ),
    );
    const admitted = holders.filter((_, index) => results[index].reserved);

    expect(admitted).toHaveLength(3);
    expect(results.filter(result => result.newlyAcquired)).toHaveLength(3);
    await expect(
      reserveConcurrencyLimitActiveJob(capacityTeamId, admitted[0], 3, 30_000),
    ).resolves.toEqual({
      reserved: true,
      newlyAcquired: false,
      rollbackToken: null,
      cleanupToken: null,
    });

    await Promise.all(
      admitted.map(holder =>
        removeConcurrencyLimitActiveJob(capacityTeamId, holder),
      ),
    );
    const replacementHolder = randomUUID();
    const replacement = await reserveConcurrencyLimitActiveJob(
      capacityTeamId,
      replacementHolder,
      3,
      30_000,
    );
    expect(replacement).toMatchObject({
      reserved: true,
      newlyAcquired: true,
      rollbackToken: expect.any(String),
    });
    await expect(
      rollbackConcurrencyLimitActiveJob(
        capacityTeamId,
        replacementHolder,
        replacement.rollbackToken!,
      ),
    ).resolves.toBe(true);
    await expect(
      reserveConcurrencyLimitActiveJob(
        capacityTeamId,
        replacementHolder,
        3,
        30_000,
      ),
    ).resolves.toMatchObject({ reserved: false });
    await expect(
      finalizeConcurrencyLimitActiveJobRollback(
        capacityTeamId,
        replacementHolder,
        replacement.rollbackToken!,
      ),
    ).resolves.toBe(true);
    const reacquired = await reserveConcurrencyLimitActiveJob(
      capacityTeamId,
      replacementHolder,
      3,
      30_000,
    );
    expect(reacquired).toMatchObject({
      reserved: true,
      newlyAcquired: true,
      rollbackToken: expect.any(String),
    });
    await expect(
      reserveConcurrencyLimitActiveJob(
        capacityTeamId,
        replacementHolder,
        3,
        30_000,
      ),
    ).resolves.toMatchObject({ newlyAcquired: false });
    await expect(
      rollbackConcurrencyLimitActiveJob(
        capacityTeamId,
        replacementHolder,
        reacquired.rollbackToken!,
      ),
    ).resolves.toBe(false);
    await removeConcurrencyLimitActiveJob(capacityTeamId, replacementHolder);
  });

  test("bounded rollback recovery needs no holder retry and fences a replacement", async () => {
    const abandoned = randomUUID();
    const first = await reserveConcurrencyLimitActiveJob(
      capacityTeamId,
      abandoned,
      3,
      30_000,
    );
    expect(first.rollbackToken).toEqual(expect.any(String));
    await expect(
      rollbackConcurrencyLimitActiveJob(
        capacityTeamId,
        abandoned,
        first.rollbackToken!,
        30_000,
      ),
    ).resolves.toBe(true);
    await expect(recoverConcurrencyLimitRollbacks(100)).resolves.toMatchObject({
      finalized: expect.any(Number),
    });
    await expect(
      getRedisConnection().get(
        `concurrency-limiter:${capacityTeamId}:reservation:${abandoned}`,
      ),
    ).resolves.toBeNull();

    const raced = randomUUID();
    const racedReservation = await reserveConcurrencyLimitActiveJob(
      capacityTeamId,
      raced,
      3,
      30_000,
    );
    await rollbackConcurrencyLimitActiveJob(
      capacityTeamId,
      raced,
      racedReservation.rollbackToken!,
      30_000,
    );
    const redis = getRedisConnection();
    await redis.zadd(
      `concurrency-limiter:${capacityTeamId}`,
      Date.now() + 30_000,
      raced,
    );
    await redis.set(
      `concurrency-limiter:${capacityTeamId}:reservation:${raced}`,
      "held",
      "PX",
      30_000,
    );
    await recoverConcurrencyLimitRollbacks(100);
    await expect(
      redis.zscore(`concurrency-limiter:${capacityTeamId}`, raced),
    ).resolves.not.toBeNull();
    await expect(
      redis.get(`concurrency-limiter:${capacityTeamId}:reservation:${raced}`),
    ).resolves.toBe("held");
    await removeConcurrencyLimitActiveJob(capacityTeamId, raced);
  });

  test("PG queue and external admissions share one atomic capacity ledger", async () => {
    const capacityTeam = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const holderId = randomUUID();
    await makeMetricsReady();
    await expect(isFdbTeam(capacityTeam)).resolves.toBe(false);
    const data = (id: string) =>
      ({
        mode: "single_urls",
        url: `https://example.com/${id}`,
        team_id: capacityTeam,
        scrapeOptions: { formats: [] },
      }) as any;

    const [first, second, external] = await Promise.all([
      addScrapeJob(data(firstId), firstId),
      addScrapeJob(data(secondId), secondId),
      reserveExternalSlot(capacityTeam, holderId, 60_000, 2),
    ]);
    expect(await getConcurrencyLimitActiveJobsCount(capacityTeam)).toBe(2);
    expect([first, second].filter(Boolean).length + Number(external)).toBe(2);

    if (external) await mirrorExternalSlotRelease(capacityTeam, holderId);
    await scrapeQueuePg.removeJobs([firstId, secondId]);
    await getRedisConnection().del(
      `concurrency-limiter:${capacityTeam}`,
      `concurrency-limit-queue:${capacityTeam}`,
      `cq-job:${firstId}`,
      `cq-job:${secondId}`,
    );
    await clearMigrationTeam(capacityTeam);
  });

  test("a pre-commit PG conflict rolls back owned Redis reservation and its prepared intent", async () => {
    const original = {
      mode: "single_urls",
      url: "https://example.com/legacy-row",
      team_id: conflictTeamId,
    } as any;
    await scrapeQueuePg.addJob(conflictJobId, original, {
      ownerId: conflictTeamId,
    });

    await expect(
      _addScrapeJobToBullMQ(
        { ...original, url: "https://example.com/incompatible" },
        conflictJobId,
      ),
    ).rejects.toBeInstanceOf(NuQPublicationConflictError);
    await expect(
      getRedisConnection().zscore(
        `concurrency-limiter:${conflictTeamId}`,
        conflictJobId,
      ),
    ).resolves.toBeNull();
    await expect(
      nuqFdbMigrationStore.inspectPin("scrape_job", conflictJobId),
    ).resolves.toMatchObject({
      backend: "pg",
      lifecycle: "terminal",
      residue: { capacity_ready_active: 0, intent_unresolved: 0 },
    });
    await expect(scrapeQueuePg.getJob(conflictJobId)).resolves.toMatchObject({
      data: { url: "https://example.com/legacy-row" },
    });
  });

  test("stable publish, incompatible retry compensation, and removal preserve one durable generation", async () => {
    const data = {
      mode: "single_urls",
      url: "https://example.com/original",
      team_id: teamId,
    } as any;

    const first = await _addScrapeJobToBullMQ(data, jobId);
    expect(first.id).toBe(jobId);
    await expect(_addScrapeJobToBullMQ(data, jobId)).resolves.toMatchObject({
      id: jobId,
    });

    const activePin = await nuqFdbMigrationStore.inspectPin(
      "scrape_job",
      jobId,
    );
    expect(activePin).toMatchObject({
      teamId,
      backend: "pg",
      generation: 1,
      lifecycle: "active",
      residue: { capacity_ready_active: 1, intent_unresolved: 0 },
    });
    expect(
      await getRedisConnection().zscore(`concurrency-limiter:${teamId}`, jobId),
    ).not.toBeNull();

    const markerKey = `nuq:job_backend:${jobId}`;
    await redisEvictConnection.set(markerKey, "corrupt");
    await expect(routedScrapeQueue.getJob(jobId)).resolves.toMatchObject({
      id: jobId,
    });
    await expect(redisEvictConnection.get(markerKey)).resolves.toBe("pg");
    await redisEvictConnection.del(markerKey);
    await expect(routedScrapeQueue.getJob(jobId)).resolves.toMatchObject({
      id: jobId,
    });
    await expect(redisEvictConnection.get(markerKey)).resolves.toBe("pg");

    await expect(
      _addScrapeJobToBullMQ(
        { ...data, url: "https://example.com/conflict" },
        jobId,
      ),
    ).rejects.toBeInstanceOf(NuQPublicationConflictError);
    await expect(
      nuqFdbMigrationStore.inspectPin("scrape_job", jobId),
    ).resolves.toMatchObject({
      lifecycle: "active",
      residue: { capacity_ready_active: 1 },
    });
    await expect(scrapeQueuePg.getJob(jobId)).resolves.toMatchObject({
      data: { url: "https://example.com/original" },
    });

    const concurrencyKey = `concurrency-limiter:${teamId}`;
    const beginFailure = new Error("injected durable deletion failure");
    const beginSpy = vi
      .spyOn(pgJobRemovalsFdb, "begin")
      .mockRejectedValueOnce(beginFailure);
    await expect(routedScrapeQueue.removeJob(jobId)).rejects.toBe(beginFailure);
    beginSpy.mockRestore();
    await expect(scrapeQueuePg.getJob(jobId)).resolves.toMatchObject({
      id: jobId,
    });
    await expect(pgJobRemovalsFdb.inspect(jobId)).resolves.toBeNull();

    await getRedisConnection().del(concurrencyKey);
    await getRedisConnection().set(concurrencyKey, "inject-zrem-failure");
    await expect(routedScrapeQueue.removeJob(jobId)).rejects.toBeInstanceOf(
      AggregateError,
    );
    await expect(scrapeQueuePg.getJob(jobId)).resolves.toBeNull();
    await expect(
      getRedisConnection().get(`nuq:pg_remove_residue:${jobId}`),
    ).resolves.not.toBeNull();
    await expect(pgJobRemovalsFdb.inspect(jobId)).resolves.toMatchObject({
      id: jobId,
      ownerId: teamId,
    });
    await expect(
      nuqFdbMigrationStore.inspectPin("scrape_job", jobId),
    ).resolves.toMatchObject({ lifecycle: "active" });

    // Model Redis loss after PG DELETE. The FDB descriptor still fences a
    // same-ID publisher and gives removal enough metadata to finish cleanup.
    await getRedisConnection().del(
      concurrencyKey,
      `nuq:pg_remove_residue:${jobId}`,
    );
    await expect(_addScrapeJobToBullMQ(data, jobId)).rejects.toBeInstanceOf(
      NuqFdbPgJobRemovalConflictError,
    );
    await expect(scrapeQueuePg.getJob(jobId)).resolves.toBeNull();
    await routedScrapeQueue.removeJob(jobId);
    await expect(
      getRedisConnection().get(`nuq:pg_remove_residue:${jobId}`),
    ).resolves.toBeNull();
    await expect(
      getRedisConnection().zscore(concurrencyKey, jobId),
    ).resolves.toBeNull();
    await expect(
      nuqFdbMigrationStore.inspectPin("scrape_job", jobId),
    ).resolves.toMatchObject({
      lifecycle: "terminal",
      residue: { capacity_ready_active: 0, intent_unresolved: 0 },
    });
    await expect(pgJobRemovalsFdb.inspect(jobId)).resolves.toBeNull();
  });

  test("PG group stable publication reconciles existing rows and compensates only proven absence", async () => {
    await isFdbTeam(groupTeamId);
    const groupId = randomUUID();
    const first = await routedCrawlGroup.addGroup(
      groupId,
      groupTeamId,
      120_000,
    );
    const replay = await routedCrawlGroup.addGroup(
      groupId,
      groupTeamId,
      120_000,
    );
    expect(replay).toMatchObject({
      id: groupId,
      ownerId: groupTeamId,
      ttl: 120_000,
    });
    expect(replay.createdAt).toEqual(first.createdAt);
    await expect(
      routedCrawlGroup.addGroup(groupId, groupTeamId, 120_001),
    ).rejects.toBeInstanceOf(NuQGroupPublicationConflictError);
    await expect(
      nuqFdbMigrationStore.inspectPin("group", groupId),
    ).resolves.toMatchObject({ lifecycle: "active", backend: "pg" });

    await isFdbTeam(ambiguousGroupTeamId);
    const ambiguousId = randomUUID();
    await nuqFdbMigrationStore.preparePinnedObject({
      teamId: ambiguousGroupTeamId,
      kind: "group",
      objectId: ambiguousId,
      admission: { type: "new-root" },
      requiredBackend: "pg",
      residue: { intent_unresolved: 1 },
    });
    const published = await crawlGroupPg.addGroup(
      ambiguousId,
      ambiguousGroupTeamId,
      90_000,
    );
    const reconciled = await routedCrawlGroup.addGroup(
      ambiguousId,
      ambiguousGroupTeamId,
      90_000,
    );
    expect(reconciled.createdAt).toEqual(published.createdAt);
    await expect(
      nuqFdbMigrationStore.inspectPin("group", ambiguousId),
    ).resolves.toMatchObject({
      lifecycle: "active",
      residue: { control_groups: 1, intent_unresolved: 0 },
    });

    await isFdbTeam(conflictGroupTeamId);
    const absentId = randomUUID();
    const injected = new Error("injected PG publication failure");
    const addSpy = vi.spyOn(crawlGroupPg, "addGroup");
    addSpy.mockRejectedValueOnce(injected);
    await expect(
      routedCrawlGroup.addGroup(absentId, conflictGroupTeamId, 30_000),
    ).rejects.toBe(injected);
    addSpy.mockRestore();
    await expect(crawlGroupPg.getGroup(absentId)).resolves.toBeNull();
    await expect(
      nuqFdbMigrationStore.inspectPin("group", absentId),
    ).resolves.toMatchObject({
      lifecycle: "terminal",
      residue: { control_groups: 0, intent_unresolved: 0 },
    });

    const incompatibleId = randomUUID();
    await crawlGroupPg.addGroup(incompatibleId, randomUUID(), 30_000);
    await expect(
      routedCrawlGroup.addGroup(incompatibleId, conflictGroupTeamId, 30_000),
    ).rejects.toBeInstanceOf(NuQGroupPublicationConflictError);
    await expect(
      nuqFdbMigrationStore.inspectPin("group", incompatibleId),
    ).resolves.toMatchObject({
      lifecycle: "prepared",
      residue: { intent_unresolved: 1 },
    });
  });

  test("sustained Redis rollback cleanup drains multiple bounded pages", async () => {
    const redis = getRedisConnection();
    const queue = "concurrency-rollback-cleanup:v1";
    await redis.del(queue);
    const now = Date.now();
    const entries = Array.from({ length: 250 }, (_, index) => {
      const teamId = `${externalTeamId}-cleanup-${index}`;
      const id = `holder-${index}`;
      const token = `token-${index}`;
      return {
        member: JSON.stringify({ v: 1, teamId, id, token }),
        marker: `concurrency-limiter:${teamId}:reservation:${id}`,
        token,
      };
    });
    const publish = redis.pipeline();
    for (const entry of entries) {
      publish.set(entry.marker, `cleanup:${entry.token}`, "PX", 60_000);
      publish.zadd(queue, now - 1, entry.member);
    }
    await publish.exec();

    await expect(
      getConcurrencyRollbackCleanupBacklog(now),
    ).resolves.toMatchObject({ due: 250 });
    const pageSizes: number[] = [];
    while ((await getConcurrencyRollbackCleanupBacklog(now)).due > 0) {
      const page = await recoverConcurrencyLimitRollbacks(100);
      pageSizes.push(page.read);
      expect(page.read).toBeLessThanOrEqual(100);
    }
    expect(pageSizes).toEqual([100, 100, 50]);
    await expect(
      getConcurrencyRollbackCleanupBacklog(now),
    ).resolves.toMatchObject({ total: 0, due: 0, oldestDueAt: null });
    expect(await redis.mget(...entries.map(entry => entry.marker))).toEqual(
      Array.from({ length: entries.length }, () => null),
    );
  });

  test("PG external holder expiry remains durable after Redis loss and ignores stale renewal generations", async () => {
    await isFdbTeam(externalTeamId);
    const concurrencyKey = `concurrency-limiter:${externalTeamId}`;
    const failedHolder = randomUUID();
    const zaddFailure = new Error("injected Redis publication failure");
    const zaddSpy = vi
      .spyOn(getRedisConnection(), "eval")
      .mockRejectedValueOnce(zaddFailure);
    await expect(
      mirrorExternalSlotAcquire(externalTeamId, failedHolder, -1),
    ).rejects.toBe(zaddFailure);
    zaddSpy.mockRestore();
    await expect(
      nuqFdbMigrationStore.inspectPin(
        "external_holder",
        externalSlotMigrationObjectId(externalTeamId, failedHolder),
      ),
    ).resolves.toMatchObject({
      backend: "pg",
      lifecycle: "active",
      residue: { capacity_external_holders: 1 },
    });
    await getRedisConnection().del(concurrencyKey);
    await getNuqFdbSweeper().sweepOnce();
    await expect(
      nuqFdbMigrationStore.inspectPin(
        "external_holder",
        externalSlotMigrationObjectId(externalTeamId, failedHolder),
      ),
    ).resolves.toMatchObject({
      lifecycle: "terminal",
      residue: { capacity_external_holders: 0 },
    });

    const expiredHolder = randomUUID();
    await mirrorExternalSlotAcquire(externalTeamId, expiredHolder, -1);
    const expiredObjectId = externalSlotMigrationObjectId(
      externalTeamId,
      expiredHolder,
    );
    await getRedisConnection().del(concurrencyKey);
    await getNuqFdbSweeper().sweepOnce();
    await expect(
      nuqFdbMigrationStore.inspectPin("external_holder", expiredObjectId),
    ).resolves.toMatchObject({
      backend: "pg",
      lifecycle: "terminal",
      residue: { capacity_external_holders: 0 },
    });

    const renewedHolder = randomUUID();
    await mirrorExternalSlotAcquire(externalTeamId, renewedHolder, 60_000);
    // Force the durable deadline due while the Redis holder remains live, then
    // exercise the heartbeat renewal path that publishes a fresh generation.
    await externalSlotsFdb.renewPg(
      externalTeamId,
      renewedHolder,
      Date.now() - 1,
    );
    let stale: [Buffer, Buffer] | undefined;
    for (let bucket = 0; bucket < TIME_BUCKETS && !stale; bucket++) {
      const range = externalSlotsFdb.pgExpiryScanRange(bucket, Date.now());
      const rows = await getNuqFdbDatabase().doTn(async tn =>
        tn.snapshot().getRangeAll(range.begin, range.end),
      );
      stale = rows[0] as [Buffer, Buffer] | undefined;
    }
    expect(stale).toBeDefined();
    await expect(
      renewExternalSlot(externalTeamId, renewedHolder, 60_000),
    ).resolves.toBe(true);
    await getRedisConnection().del(concurrencyKey);
    await getNuqFdbDatabase().doTn(async tn => tn.set(stale![0], stale![1]));
    await getNuqFdbSweeper().sweepOnce();
    await expect(
      nuqFdbMigrationStore.inspectPin(
        "external_holder",
        externalSlotMigrationObjectId(externalTeamId, renewedHolder),
      ),
    ).resolves.toMatchObject({
      lifecycle: "active",
      residue: { capacity_external_holders: 1 },
    });
    await mirrorExternalSlotRelease(externalTeamId, renewedHolder);
  });
});
