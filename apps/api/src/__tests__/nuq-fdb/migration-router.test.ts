import { randomUUID } from "crypto";
import { vi } from "vitest";

const controls = vi.hoisted(() => ({
  fdbFlag: false,
  pgResidue: 0,
  redisReserve: vi.fn(),
  redisRemove: vi.fn(),
  redisRollback: vi.fn(),
  redisFinalize: vi.fn(),
}));

vi.mock("../../controllers/auth", () => ({
  getACUCTeam: vi.fn(async () => ({ flags: { nuqFdb: controls.fdbFlag } })),
}));
vi.mock("../../lib/deployment", () => ({ isSelfHosted: vi.fn(() => false) }));
vi.mock("../../services/worker/nuq", () => {
  const queue = {
    getJob: vi.fn().mockResolvedValue(null),
    getJobs: vi.fn().mockResolvedValue([]),
    getJobsFromBacklog: vi.fn().mockResolvedValue([]),
    getJobToProcess: vi.fn().mockResolvedValue(null),
  };
  return {
    scrapeQueue: queue,
    crawlFinishedQueue: queue,
    crawlGroup: {
      getGroup: vi.fn().mockResolvedValue(null),
      getOngoingByOwner: vi.fn().mockResolvedValue([]),
    },
    getNuQPgOwnerLiveResidue: vi.fn(async () => ({
      scrape: controls.pgResidue,
      backlog: 0,
      groups: 0,
      crawlFinished: 0,
      total: controls.pgResidue,
    })),
  };
});
vi.mock("../../lib/concurrency-redis", () => ({
  finalizeConcurrencyLimitActiveJobRollback: controls.redisFinalize,
  getTeamQueueLimit: vi.fn().mockResolvedValue(100),
  getConcurrencyLimitActiveJobsCount: vi.fn().mockResolvedValue(0),
  getConcurrencyRollbackCleanupBacklog: vi.fn().mockResolvedValue({
    total: 0,
    due: 0,
    oldestDueAt: null,
    oldestOverdueMs: 0,
  }),
  recoverConcurrencyLimitRollbacks: vi.fn().mockResolvedValue({
    read: 0,
    finalized: 0,
    fenced: 0,
    hasMore: false,
  }),
  pushConcurrencyLimitActiveJob: vi.fn(),
  removeConcurrencyLimitActiveJob: controls.redisRemove,
  renewConcurrencyLimitActiveJob: vi.fn().mockResolvedValue(true),
  reserveConcurrencyLimitActiveJob: controls.redisReserve,
  rollbackConcurrencyLimitActiveJob: controls.redisRollback,
  constructConcurrencyLimitKey: vi.fn((teamId: string) => `limit:${teamId}`),
}));

import { config } from "../../config";
import { getRedisConnection } from "../../services/queue-service";
import {
  isFdbTeam,
  mirrorExternalSlotAcquire,
  mirrorExternalSlotRelease,
  reserveExternalSlot,
  resolveJobBackend,
} from "../../services/worker/nuq-router";
import {
  crawlFinishedQueueFdb,
  crawlGroupFdb,
  externalSlotMigrationObjectId,
  externalSlotsFdb,
  NuqFdbSweeper,
  nuqFdbMigrationStore,
  scrapeQueueFdb,
} from "../../services/worker/nuq-fdb";
import { getNuqFdbDatabase } from "../../services/worker/nuq-fdb/client";
import { decodeJson, timeBucket } from "../../services/worker/nuq-fdb/keyspace";
import { clearMigrationTestTeams } from "./migration-test-cleanup";

const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;
const teams = new Set<string>();
const previousBackend = config.NUQ_BACKEND;
const previousMetricsActivation = config.NUQ_FDB_METRICS_V2_ACTIVATE;

async function makeMetricsReady(): Promise<void> {
  for (const queue of [scrapeQueueFdb, crawlFinishedQueueFdb]) {
    await queue.beginMetricCounterBackfill();
    while (!(await queue.backfillMetricCounts(100))) {
      // bounded pages; queues are empty in this focused suite
    }
  }
  while (!(await crawlGroupFdb.backfillLegacyOwnerIndex(100))) {
    // bounded pages
  }
}

async function waitForGroupMaintenanceLeaseExpiry(
  groupId: string,
): Promise<void> {
  const db = getNuqFdbDatabase();
  const bucket = timeBucket(groupId);
  const keys = [
    scrapeQueueFdb.ks.sweeperPartition("group-cancel", bucket),
    scrapeQueueFdb.ks.sweeperPartition("group-finish", bucket),
  ];
  let waitDeadline: number | null = null;

  while (true) {
    const expiresAt = await db.doTn(async tn =>
      Promise.all(
        keys.map(
          async key =>
            decodeJson<{ x: number }>(await tn.snapshot().get(key))?.x ?? 0,
        ),
      ),
    );
    const now = Date.now();
    const latestActiveLease = Math.max(...expiresAt.filter(at => at > now), 0);
    if (latestActiveLease === 0) return;

    // A prior test process may have exited immediately after a full sweep,
    // leaving these exact partitions fenced for the remainder of their
    // protocol lease. Wait for that recorded deadline rather than racing it
    // with a fixed number of rapid sweeps. A live owner renewing the lease is
    // an isolation failure, not permission for this test to steal its claim.
    waitDeadline ??= latestActiveLease + 1_000;
    const deadline = waitDeadline;
    if (latestActiveLease > deadline || now >= deadline) {
      throw new Error("group maintenance partition lease remained active");
    }
    await new Promise(resolve =>
      setTimeout(
        resolve,
        Math.min(latestActiveLease + 1 - now, deadline - now),
      ),
    );
  }
}

describeIf("NuQ durable migration router", () => {
  beforeAll(async () => {
    config.NUQ_BACKEND = "pg";
    config.NUQ_FDB_METRICS_V2_ACTIVATE = true;
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await Promise.all([
      scrapeQueueFdb.invalidateMetricCounterGeneration(),
      crawlFinishedQueueFdb.invalidateMetricCounterGeneration(),
    ]);
  });

  afterAll(async () => {
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    config.NUQ_BACKEND = previousBackend;
    config.NUQ_FDB_METRICS_V2_ACTIVATE = previousMetricsActivation;
    await clearMigrationTestTeams(teams);
  });

  test("freezes authority initialization until both corrected-core counters are ready", async () => {
    const teamId = randomUUID();
    teams.add(teamId);

    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_FDB_CORE_METRICS_NOT_READY",
      retryable: true,
    });
    await expect(nuqFdbMigrationStore.inspectState(teamId)).resolves.toBeNull();

    await makeMetricsReady();
    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      activeBackend: "pg",
      activeGeneration: 1,
      phase: "PG_ONLY",
    });
  });

  test("disabled activation invalidates prior READY generations before rollback writers", async () => {
    const teamId = randomUUID();
    teams.add(teamId);
    config.NUQ_FDB_METRICS_V2_ACTIVATE = false;
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_FDB_CORE_METRICS_NOT_ACTIVATED",
      retryable: true,
    });
    await expect(
      scrapeQueueFdb.getMetricCounterBackfillStatus(),
    ).resolves.toBeNull();
    await expect(
      crawlFinishedQueueFdb.getMetricCounterBackfillStatus(),
    ).resolves.toBeNull();
    config.NUQ_FDB_METRICS_V2_ACTIVATE = true;
    await makeMetricsReady();
  });

  test("begin and final seal require both corrected-core generations in their own transactions", async () => {
    const teamId = randomUUID();
    teams.add(teamId);
    await expect(isFdbTeam(teamId)).resolves.toBe(false);

    await crawlFinishedQueueFdb.invalidateMetricCounterGeneration();
    await expect(
      nuqFdbMigrationStore.beginTransition({
        teamId,
        targetBackend: "fdb",
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "NUQ_FDB_CORE_METRICS_NOT_READY",
      retryable: true,
    });

    await makeMetricsReady();
    const transition = await nuqFdbMigrationStore.beginTransition({
      teamId,
      targetBackend: "fdb",
      operationId: randomUUID(),
    });
    await scrapeQueueFdb.invalidateMetricCounterGeneration();
    await expect(
      nuqFdbMigrationStore.finalSeal({
        teamId,
        transitionOperationId: transition.transitionOperationId!,
      }),
    ).rejects.toMatchObject({
      code: "NUQ_FDB_CORE_METRICS_NOT_READY",
      retryable: true,
    });

    await makeMetricsReady();
    await expect(
      nuqFdbMigrationStore.finalSeal({
        teamId,
        transitionOperationId: transition.transitionOperationId!,
      }),
    ).resolves.toMatchObject({
      activeBackend: "fdb",
      phase: "FDB_ONLY",
    });
  });

  test("discovers and drains an uncounted pre-protocol FDB job without dual authority", async () => {
    const teamId = randomUUID();
    const jobId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await scrapeQueueFdb.addJob(
      jobId,
      {
        mode: "single_urls",
        url: "https://example.com/legacy-direct",
        team_id: teamId,
      } as any,
      { ownerId: teamId, bypassGate: true },
      { teamLimit: 1, queueCap: 10 },
    );

    // The owner index catches bypass jobs that intentionally hold no team slot.
    await expect(isFdbTeam(teamId)).resolves.toBe(true);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      activeBackend: "fdb",
      phase: "FDB_ONLY",
    });
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });

    const active = await scrapeQueueFdb.getJobToProcess();
    expect(active?.id).toBe(jobId);
    await scrapeQueueFdb.jobFinish(jobId, active!.lock!, {});
    await scrapeQueueFdb.removeJob(jobId);
    await expect(
      nuqFdbMigrationStore.inspectPin("scrape_job", jobId),
    ).resolves.toMatchObject({
      admission: "legacy-backfill",
      lifecycle: "terminal",
    });

    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      activeBackend: "pg",
      phase: "PG_ONLY",
    });
  });

  test("a legacy FDB group pins descendants and crawl-finished control through drain", async () => {
    const teamId = randomUUID();
    const groupId = randomUUID();
    const childId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await crawlGroupFdb.addGroup(groupId, teamId);

    const data = {
      mode: "single_urls",
      team_id: teamId,
      crawl_id: groupId,
      url: "https://example.com/legacy-group",
    } as any;
    await expect(resolveJobBackend(data)).resolves.toBe("fdb");
    await expect(
      nuqFdbMigrationStore.inspectPin("group", groupId),
    ).resolves.toMatchObject({
      admission: "legacy-backfill",
      backend: "fdb",
      lifecycle: "active",
    });
    await nuqFdbMigrationStore.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId: childId,
      admission: {
        type: "pinned-continuation",
        source: { kind: "group", objectId: groupId },
      },
      requiredBackend: "fdb",
      residue: { intent_unresolved: 1 },
    });
    await scrapeQueueFdb.addJob(
      childId,
      data,
      { ownerId: teamId, groupId },
      { teamLimit: null, queueCap: 10 },
    );

    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });
    const child = await scrapeQueueFdb.getJobToProcess();
    expect(child?.id).toBe(childId);
    await scrapeQueueFdb.jobFinish(childId, child!.lock!, {});
    const finished = await crawlFinishedQueueFdb.getJobToProcess();
    expect(finished?.groupId).toBe(groupId);
    await crawlFinishedQueueFdb.jobFinish(finished!.id, finished!.lock!, {});
    await Promise.all([
      scrapeQueueFdb.removeJob(childId),
      crawlFinishedQueueFdb.removeJob(finished!.id),
    ]);

    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      activeBackend: "pg",
      phase: "PG_ONLY",
    });
    const db = getNuqFdbDatabase();
    await db.doTn(async tn => {
      const range = crawlGroupFdb.ks.groupRange(groupId);
      tn.clearRange(range.begin, range.end);
      tn.clear(crawlGroupFdb.ks.ongoingGroup(teamId, groupId));
    });
  });

  test("cancelled legacy groups remain source residue until their sweeper control finishes", async () => {
    const teamId = randomUUID();
    const groupId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await crawlGroupFdb.addGroup(groupId, teamId);
    await crawlGroupFdb.cancelGroup(groupId);

    await expect(isFdbTeam(teamId)).resolves.toBe(true);
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });
    const sweeper = new NuqFdbSweeper(
      [scrapeQueueFdb, crawlFinishedQueueFdb],
      [],
    );
    await waitForGroupMaintenanceLeaseExpiry(groupId);
    let finished = await crawlFinishedQueueFdb.getJobToProcess();
    for (let attempt = 0; attempt < 20 && !finished; attempt++) {
      await sweeper.sweepOnce();
      finished = await crawlFinishedQueueFdb.getJobToProcess();
    }
    expect(finished?.groupId).toBe(groupId);
    await crawlFinishedQueueFdb.jobFinish(finished!.id, finished!.lock!, {});
    await crawlFinishedQueueFdb.removeJob(finished!.id);
    await expect(isFdbTeam(teamId)).resolves.toBe(false);

    const db = getNuqFdbDatabase();
    await db.doTn(async tn => {
      const range = crawlGroupFdb.ks.groupRange(groupId);
      tn.clearRange(range.begin, range.end);
      tn.clear(crawlGroupFdb.ks.ongoingGroup(teamId, groupId));
    });
  });

  test("denied PG reservations do not create a migration intent", async () => {
    const teamId = randomUUID();
    const holderId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    controls.redisReserve.mockResolvedValueOnce({
      reserved: false,
      newlyAcquired: false,
      rollbackToken: null,
      cleanupToken: null,
    });
    await makeMetricsReady();
    await expect(isFdbTeam(teamId)).resolves.toBe(false);

    await expect(
      reserveExternalSlot(teamId, holderId, 30_000, 1),
    ).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectPin(
        "external_holder",
        externalSlotMigrationObjectId(teamId, holderId),
      ),
    ).resolves.toBeNull();
  });

  test("failed PG durable-expiry publication removes a new Redis holder and retires its intent", async () => {
    const teamId = randomUUID();
    const holderId = randomUUID();
    const activationError = new Error("activation unavailable");
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    controls.redisReserve.mockResolvedValueOnce({
      reserved: true,
      newlyAcquired: true,
      rollbackToken: "owned-attempt",
      cleanupToken: null,
    });
    controls.redisRollback.mockResolvedValueOnce(true);
    controls.redisFinalize.mockResolvedValueOnce(true);
    await makeMetricsReady();
    await expect(isFdbTeam(teamId)).resolves.toBe(false);

    const transition = vi
      .spyOn(externalSlotsFdb, "renewPg")
      .mockRejectedValueOnce(activationError);
    try {
      await expect(
        reserveExternalSlot(teamId, holderId, 30_000, 1),
      ).rejects.toBe(activationError);
    } finally {
      transition.mockRestore();
    }
    expect(controls.redisRollback).toHaveBeenCalledWith(
      teamId,
      holderId,
      "owned-attempt",
      30_000,
    );
    expect(controls.redisFinalize).toHaveBeenCalledWith(
      teamId,
      holderId,
      "owned-attempt",
    );
    await expect(
      nuqFdbMigrationStore.inspectPin(
        "external_holder",
        externalSlotMigrationObjectId(teamId, holderId),
      ),
    ).resolves.toBeNull();
  });

  test("stale PG durable-expiry failure cannot roll back a replacement holder", async () => {
    const teamId = randomUUID();
    const holderId = randomUUID();
    const objectId = externalSlotMigrationObjectId(teamId, holderId);
    const activationError = new Error("activation unavailable");
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    controls.redisReserve.mockResolvedValueOnce({
      reserved: true,
      newlyAcquired: true,
      rollbackToken: "stale-attempt",
      cleanupToken: null,
    });
    controls.redisRollback.mockResolvedValueOnce(false);
    controls.redisFinalize.mockClear();
    await makeMetricsReady();
    await expect(isFdbTeam(teamId)).resolves.toBe(false);

    const transition = vi
      .spyOn(externalSlotsFdb, "renewPg")
      .mockRejectedValueOnce(activationError);
    try {
      await expect(
        reserveExternalSlot(teamId, holderId, 30_000, 1),
      ).rejects.toBe(activationError);
    } finally {
      transition.mockRestore();
    }
    expect(controls.redisRollback).toHaveBeenCalledWith(
      teamId,
      holderId,
      "stale-attempt",
      30_000,
    );
    expect(controls.redisFinalize).not.toHaveBeenCalled();
    await expect(
      nuqFdbMigrationStore.inspectPin("external_holder", objectId),
    ).resolves.toBeNull();
  });

  test("retry recovers an abandoned PG rollback tombstone", async () => {
    const teamId = randomUUID();
    const holderId = randomUUID();
    const objectId = externalSlotMigrationObjectId(teamId, holderId);
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await makeMetricsReady();
    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await nuqFdbMigrationStore.preparePinnedObject({
      teamId,
      kind: "external_holder",
      objectId,
      admission: { type: "new-root" },
      requiredBackend: "pg",
      residue: { intent_unresolved: 1 },
    });
    controls.redisRollback.mockClear();
    controls.redisFinalize.mockClear();
    controls.redisReserve.mockResolvedValueOnce({
      reserved: false,
      newlyAcquired: false,
      rollbackToken: null,
      cleanupToken: "abandoned-attempt",
    });
    controls.redisFinalize.mockResolvedValueOnce(true);

    await expect(
      reserveExternalSlot(teamId, holderId, 30_000, 1),
    ).resolves.toBe(false);
    expect(controls.redisFinalize).toHaveBeenCalledWith(
      teamId,
      holderId,
      "abandoned-attempt",
    );
    await expect(
      nuqFdbMigrationStore.inspectPin("external_holder", objectId),
    ).resolves.toMatchObject({
      lifecycle: "terminal",
      residue: { intent_unresolved: 0 },
    });

    // A finalize commit-unknown retry must not reopen this terminal holder ID.
    controls.redisReserve.mockResolvedValueOnce({
      reserved: true,
      newlyAcquired: true,
      rollbackToken: "reopened-attempt",
      cleanupToken: null,
    });
    controls.redisRollback.mockResolvedValueOnce(true);
    controls.redisFinalize.mockResolvedValueOnce(true);
    await expect(
      reserveExternalSlot(teamId, holderId, 30_000, 1),
    ).resolves.toBe(false);
    expect(controls.redisRollback).toHaveBeenCalledWith(
      teamId,
      holderId,
      "reopened-attempt",
      30_000,
    );
    await expect(
      nuqFdbMigrationStore.inspectPin("external_holder", objectId),
    ).resolves.toMatchObject({ lifecycle: "terminal" });
  });

  test("failed PG durable-expiry renewal does not remove or terminalize an existing holder", async () => {
    const teamId = randomUUID();
    const holderId = randomUUID();
    const objectId = externalSlotMigrationObjectId(teamId, holderId);
    const activationError = new Error("activation unavailable");
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await makeMetricsReady();
    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await nuqFdbMigrationStore.preparePinnedObject({
      teamId,
      kind: "external_holder",
      objectId,
      admission: { type: "new-root" },
      requiredBackend: "pg",
      residue: { intent_unresolved: 1 },
    });
    controls.redisReserve.mockResolvedValueOnce({
      reserved: true,
      newlyAcquired: false,
      rollbackToken: null,
      cleanupToken: null,
    });
    controls.redisRollback.mockClear();

    const transition = vi
      .spyOn(externalSlotsFdb, "renewPg")
      .mockRejectedValueOnce(activationError);
    try {
      await expect(
        reserveExternalSlot(teamId, holderId, 30_000, 1),
      ).rejects.toBe(activationError);
    } finally {
      transition.mockRestore();
    }
    expect(controls.redisRollback).not.toHaveBeenCalled();
    await expect(
      nuqFdbMigrationStore.inspectPin("external_holder", objectId),
    ).resolves.toMatchObject({
      lifecycle: "prepared",
      residue: { intent_unresolved: 1 },
    });
  });

  test("legacy external holders detect dual presence and retain their FDB generation", async () => {
    const teamId = randomUUID();
    const holderId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await externalSlotsFdb.acquire(teamId, holderId, 60_000);
    await getRedisConnection().zadd(
      `limit:${teamId}`,
      Date.now() + 60_000,
      holderId,
    );

    await expect(
      mirrorExternalSlotAcquire(teamId, holderId, 120_000),
    ).rejects.toMatchObject({ code: "NUQ_ROUTER_BOTH_BACKENDS_PRESENT" });
    await getRedisConnection().zrem(`limit:${teamId}`, holderId);

    await mirrorExternalSlotAcquire(teamId, holderId, 120_000);
    const externalObjectId = externalSlotMigrationObjectId(teamId, holderId);
    await expect(
      nuqFdbMigrationStore.inspectPin("external_holder", externalObjectId),
    ).resolves.toMatchObject({
      admission: "legacy-backfill",
      backend: "fdb",
      lifecycle: "active",
      residue: { capacity_external_holders: 1 },
    });
    await mirrorExternalSlotRelease(teamId, holderId);
    await expect(externalSlotsFdb.has(teamId, holderId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectPin("external_holder", externalObjectId),
    ).resolves.toMatchObject({ lifecycle: "terminal" });
  });

  test("durable source residue blocks seal until the authoritative ledger drains", async () => {
    const teamId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 1;
    await expect(isFdbTeam(teamId)).resolves.toBe(false);

    controls.fdbFlag = true;
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_RESIDUE_NOT_EMPTY",
      retryable: true,
    });
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "DRAINING_TO_FDB",
      activeBackend: "pg",
    });

    controls.pgResidue = 0;
    await expect(isFdbTeam(teamId)).resolves.toBe(true);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "FDB_ONLY",
      activeBackend: "fdb",
    });
  });

  test("pause/drain seals both directions and a flag flap burns its target generation", async () => {
    const teamId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await expect(isFdbTeam(teamId)).resolves.toBe(false);

    controls.fdbFlag = true;
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
      retryable: true,
    });
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "DRAINING_TO_FDB",
      targetGeneration: 2,
    });

    controls.fdbFlag = false;
    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "PG_ONLY",
      activeGeneration: 1,
      maxGeneration: 2,
    });

    controls.fdbFlag = true;
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "DRAINING_TO_FDB",
      targetGeneration: 3,
    });
    await expect(isFdbTeam(teamId)).resolves.toBe(true);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "FDB_ONLY",
      activeGeneration: 3,
      maxGeneration: 3,
    });

    controls.fdbFlag = false;
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });
    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "PG_ONLY",
      activeGeneration: 4,
      maxGeneration: 4,
    });
  });
});
