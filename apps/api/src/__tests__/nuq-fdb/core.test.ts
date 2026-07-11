import { randomUUID } from "crypto";
import { config } from "../../config";
import {
  NuQFdbQueue,
  NuQFdbJobGroup,
  NuqFdbSweeper,
} from "../../services/worker/nuq-fdb";
import {
  getNuqFdbDatabase,
  getFdb,
} from "../../services/worker/nuq-fdb/client";
import {
  decodeI64,
  encodeI64,
  encodeJson,
  fnv1a,
  METRIC_SHARDS,
  METRIC_STATUSES,
  NuqFdbMetricStatus,
} from "../../services/worker/nuq-fdb/keyspace";
import { newTxContext, uvSuffix } from "../../services/worker/nuq-fdb/ops";

// These tests exercise the FDB queue core directly against a real FoundationDB
// cluster (no API server needed). They are skipped when FDB is not configured.
const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;

// inline returnvalues only exist on the self-host path; cloud stores to GCS
const expectInlineReturnvalue = !config.GCS_BUCKET_NAME;

const RUN = randomUUID().slice(0, 8);
const TEST_LEASE_MS = 1500;

const createdQueueNames: string[] = [];
const previousMetricsActivation = config.NUQ_FDB_METRICS_V2_ACTIVATE;

type Ctx = {
  queue: NuQFdbQueue;
  finishedQueue: NuQFdbQueue;
  group: NuQFdbJobGroup;
  sweeper: NuqFdbSweeper;
};

// Each test gets its own queue keyspace so leaked jobs (some tests leave them
// behind on purpose) can never bleed into other tests' takes.
async function makeCtx(
  name: string,
  overrides: Partial<ConstructorParameters<typeof NuQFdbQueue>[1]> = {},
): Promise<Ctx> {
  const scrapeName = `t-${RUN}-${name}`;
  const finishedName = `t-${RUN}-${name}-fin`;
  createdQueueNames.push(scrapeName, finishedName);
  const queue = new NuQFdbQueue(scrapeName, {
    hasGroups: true,
    finishedQueueName: finishedName,
    leaseMs: TEST_LEASE_MS,
    ...overrides,
  });
  const finishedQueue = new NuQFdbQueue(finishedName, { hasGroups: false });
  await activateMetricGeneration(queue);
  await activateMetricGeneration(finishedQueue);
  const group = new NuQFdbJobGroup(queue.ks, queue.groupOps!);
  const sweeper = new NuqFdbSweeper([queue, finishedQueue]);
  return { queue, finishedQueue, group, sweeper };
}

async function activateMetricGeneration(
  queue: NuQFdbQueue,
  batchSize = 100,
): Promise<void> {
  await queue.beginMetricCounterBackfill();
  for (let page = 0; page < 10_000; page++) {
    if (await queue.backfillMetricCounts(batchSize)) return;
  }
  throw new Error("metric generation did not become READY");
}

async function takeAll(
  queue: NuQFdbQueue,
  maxJobs: number = 50,
): Promise<any[]> {
  const out: any[] = [];
  while (out.length < maxJobs) {
    const job = await queue.getJobToProcess();
    if (job === null) break;
    out.push(job);
  }
  return out;
}

function freshOwner(): string {
  return randomUUID();
}

function scrapeData(extra: Record<string, any> = {}): any {
  return { mode: "single_urls", url: "https://example.com", ...extra };
}

const UNLIMITED = { teamLimit: null, queueCap: 1_000_000 };
const gate = (limit: number, cap: number = 1_000_000) => ({
  teamLimit: limit,
  queueCap: cap,
});

async function readMetricInvariant(queue: NuQFdbQueue): Promise<{
  generation: string;
  ledger: Map<string, NuqFdbMetricStatus>;
  counts: Record<NuqFdbMetricStatus, number>;
}> {
  const control = await queue.getMetricCounterBackfillStatus();
  if (!control) throw new Error("metric control is absent");
  return await getNuqFdbDatabase().doTn(async tn => {
    const ledgerRange = queue.ks.metricLedgerRange(control.generation);
    const rows = await tn
      .snapshot()
      .getRangeAll(ledgerRange.begin, ledgerRange.end);
    const ledger = new Map<string, NuqFdbMetricStatus>();
    for (const [key, value] of rows) {
      ledger.set(
        queue.ks.unpackId(key as Buffer),
        (value as Buffer).toString("utf8") as NuqFdbMetricStatus,
      );
    }
    const counts = Object.fromEntries(
      await Promise.all(
        METRIC_STATUSES.map(async status => [
          status,
          (
            await Promise.all(
              Array.from({ length: METRIC_SHARDS }, (_, shard) =>
                tn
                  .snapshot()
                  .get(queue.ks.metricCount(control.generation, status, shard)),
              ),
            )
          ).reduce((sum, value) => sum + decodeI64(value), 0),
        ]),
      ),
    ) as Record<NuqFdbMetricStatus, number>;
    return { generation: control.generation, ledger, counts };
  });
}

function countsFromLedger(
  ledger: Map<string, NuqFdbMetricStatus>,
): Record<NuqFdbMetricStatus, number> {
  const counts = Object.fromEntries(
    METRIC_STATUSES.map(status => [status, 0]),
  ) as Record<NuqFdbMetricStatus, number>;
  for (const status of ledger.values()) counts[status]++;
  return counts;
}

describeIf("NuQ FDB core", () => {
  beforeAll(() => {
    // This suite explicitly activates and validates maintained generations.
    // Keep the runtime sweeper in release-B mode so it does not correctly
    // invalidate those generations as a disabled rollout would in production.
    config.NUQ_FDB_METRICS_V2_ACTIVATE = true;
  });

  afterAll(async () => {
    try {
      const fdb = getFdb();
      const db = getNuqFdbDatabase();
      for (const name of createdQueueNames) {
        const r = fdb.tuple.range(["nuq", name]);
        await db.doTn(async tn =>
          tn.clearRange(r.begin as Buffer, r.end as Buffer),
        );
      }
    } finally {
      config.NUQ_FDB_METRICS_V2_ACTIVATE = previousMetricsActivation;
    }
  });

  test("enqueue -> take -> finish roundtrip (ungated)", async () => {
    const { queue } = await makeCtx("roundtrip");
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: freshOwner() }, UNLIMITED);

    const taken = await takeAll(queue, 1);
    expect(taken.length).toBe(1);
    expect(taken[0].backend).toBe("fdb");
    expect(taken[0].id).toBe(id);
    expect(taken[0].lock).toBeDefined();
    expect(taken[0].data.url).toBe("https://example.com");

    const ok = await queue.jobFinish(id, taken[0].lock!, { result: "yay" });
    expect(ok).toBe(true);

    const job = await queue.getJob(id);
    expect(job?.backend).toBe("fdb");
    expect(job?.status).toBe("completed");
    if (expectInlineReturnvalue) {
      expect(job?.returnvalue).toEqual({ result: "yay" });
    } else {
      expect(job?.returnvalue).toBeNull();
    }
  });

  test("finish with wrong lock is rejected; double finish is idempotent", async () => {
    const { queue } = await makeCtx("locks");
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: freshOwner() }, UNLIMITED);
    const [job] = await takeAll(queue, 1);
    expect(job.id).toBe(id);

    expect(await queue.jobFinish(id, randomUUID(), null)).toBe(false);
    expect(await queue.jobFinish(id, job.lock!, { ok: 1 })).toBe(true);
    expect(await queue.jobFinish(id, job.lock!, { ok: 1 })).toBe(true);
    expect(await queue.jobFail(id, job.lock!, "nope")).toBe(false);
  });

  test("duplicate IDs are idempotent within and across enqueue calls", async () => {
    const { queue, group } = await makeCtx("enqueue-idempotent");
    const owner = freshOwner();
    const gid = randomUUID();
    const id = randomUUID();
    await group.addGroup(gid, owner, undefined, { maxConcurrency: 1 });
    const input = {
      id,
      data: scrapeData(),
      options: { ownerId: owner, groupId: gid },
    };
    const strictGate = {
      teamLimit: 1,
      queueCap: 10,
      key: { id: randomUUID(), limit: 1 },
    };

    const first = await queue.addJobs([input, input, input], strictGate);
    expect(first).toHaveLength(3);
    expect(first.every(job => job.id === id)).toBe(true);
    await queue.addJob(
      id,
      scrapeData({ ignored: true }),
      { ownerId: owner, groupId: gid },
      strictGate,
    );
    expect(await queue.getTeamActiveCount(owner)).toBe(1);
    expect((await queue.getGroupNumericStats(gid)).queued).toBe(1);

    const taken = await takeAll(queue, 10);
    expect(taken.map(job => job.id)).toEqual([id]);
    await queue.jobFinish(id, taken[0].lock!, null);
    expect(await queue.getWorkerLoadCount()).toBe(0);
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
    expect((await group.getGroup(gid))?.status).toBe("completed");
  });

  test("structurally distinct ID lists cannot share an ingest manifest", async () => {
    let stopFirst = true;
    const { queue } = await makeCtx("ingest-identity-encoding", {
      testHooks: {
        afterManifest: async () => {
          if (!stopFirst) return;
          stopFirst = false;
          throw new Error("stop first ingest after manifest");
        },
      },
    });
    const owner = freshOwner();
    const inputs = (ids: string[]) =>
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner },
      }));
    const firstIds = ["a\0b", "c"];
    const secondIds = ["a", "b\0c"];

    await expect(queue.addJobs(inputs(firstIds), UNLIMITED)).rejects.toThrow(
      "stop first ingest after manifest",
    );
    await expect(queue.addJobs(inputs(secondIds), UNLIMITED)).resolves.toEqual(
      expect.arrayContaining(
        secondIds.map(id => expect.objectContaining({ id })),
      ),
    );
    await expect(queue.addJobs(inputs(firstIds), UNLIMITED)).resolves.toEqual(
      expect.arrayContaining(
        firstIds.map(id => expect.objectContaining({ id })),
      ),
    );

    const taken = await takeAll(queue, 4);
    expect(new Set(taken.map(job => job.id))).toEqual(
      new Set([...firstIds, ...secondIds]),
    );
  });

  test("dequeue recovers the original claim after simulated commit_unknown_result", async () => {
    let inject = true;
    const { queue } = await makeCtx("claim-unknown", {
      testHooks: {
        simulateClaimCommitUnknown: () => {
          if (!inject) return false;
          inject = false;
          return true;
        },
      },
    });
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: freshOwner() }, UNLIMITED);

    const job = await queue.getJobToProcess();
    expect(job?.id).toBe(id);
    expect(await queue.getJobToProcess()).toBeNull();
    expect(await queue.jobFinish(id, job!.lock!, null)).toBe(true);
  });

  test("a failed >250-job stage stays invisible and resumes without duplicates", async () => {
    let failAfterFirstBatch = true;
    const { queue, finishedQueue, group, sweeper } = await makeCtx(
      "bulk-resume",
      {
        testHooks: {
          afterStageBatch: async batch => {
            if (batch === 1 && failAfterFirstBatch) {
              failAfterFirstBatch = false;
              throw new Error("injected later stage failure");
            }
          },
        },
      },
    );
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);
    const inputs = Array.from({ length: 251 }, () => ({
      id: randomUUID(),
      data: scrapeData({ traceContext: "first-attempt" }),
      options: { ownerId: owner, groupId: gid },
    }));

    await expect(queue.addJobs(inputs, UNLIMITED)).rejects.toThrow(
      "injected later stage failure",
    );
    const early = await takeAll(queue, 251);
    expect(early).toEqual([]);
    expect((await group.getGroup(gid))?.status).toBe("active");
    expect(await finishedQueue.getJobToProcess()).toBeNull();

    const resumed = await queue.addJobs(
      inputs.map(input => ({
        ...input,
        data: { ...input.data, traceContext: "regenerated-retry-trace" },
        options: {
          ...input.options,
          timesOutAt: new Date(Date.now() + 60_000),
        },
      })),
      gate(1),
    );
    expect(resumed).toHaveLength(251);
    expect(resumed.every(job => job.status === "queued")).toBe(true);
    const later = await takeAll(queue, 251);
    const seen = new Set(later.map(job => job.id));
    expect(seen.size).toBe(251);
    await Promise.all(
      later.map(job => queue.jobFinish(job.id, job.lock!, null)),
    );
    await sweeper.sweepOnce();
    expect((await group.getGroup(gid))?.status).toBe("completed");
    expect(await finishedQueue.getJobToProcess()).not.toBeNull();
  }, 60_000);

  test("a concurrent retry cannot recreate a manifest after publication", async () => {
    let manifestCalls = 0;
    let publishCalls = 0;
    let signalPublished!: () => void;
    let releasePublisher!: () => void;
    const published = new Promise<void>(resolve => (signalPublished = resolve));
    const holdPublisher = new Promise<void>(
      resolve => (releasePublisher = resolve),
    );
    const { queue } = await makeCtx("manifest-publish-race", {
      testHooks: {
        afterManifest: async () => {
          manifestCalls++;
          if (manifestCalls === 2)
            throw new Error("retry stopped after manifest");
        },
        afterPublishBatch: async () => {
          publishCalls++;
          if (publishCalls === 1) {
            signalPublished();
            await holdPublisher;
          }
        },
      },
    });
    const owner = freshOwner();
    const inputs = Array.from({ length: 251 }, () => ({
      id: randomUUID(),
      data: scrapeData(),
      options: { ownerId: owner },
    }));

    const first = queue.addJobs(inputs, UNLIMITED);
    await published;
    await expect(queue.addJobs(inputs, UNLIMITED)).rejects.toThrow(
      "retry stopped after manifest",
    );
    releasePublisher();
    await expect(first).resolves.toHaveLength(251);
  }, 30_000);

  test("a later oversized job fails before any bulk enqueue reservation", async () => {
    const { queue } = await makeCtx("bulk-preflight");
    const owner = freshOwner();
    const firstId = randomUUID();
    const inputs = Array.from({ length: 250 }, (_, i) => ({
      id: i === 0 ? firstId : randomUUID(),
      data: scrapeData(),
      options: { ownerId: owner },
    }));
    inputs.push({
      id: randomUUID(),
      data: scrapeData({ blob: "x".repeat(9 * 1024 * 1024) }),
      options: { ownerId: owner },
    });

    await expect(queue.addJobs(inputs, UNLIMITED)).rejects.toThrow(
      /too large to enqueue safely/,
    );
    expect(await queue.getJob(firstId)).toBeNull();
    expect(await queue.getJobToProcess()).toBeNull();
  });

  test("a 2,000-job ingest stages and publishes in bounded transactions", async () => {
    const { queue } = await makeCtx("bulk-publication-bounded");
    const owner = freshOwner();
    const ids = Array.from({ length: 2_000 }, () => randomUUID());
    const jobs = await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner },
      })),
      UNLIMITED,
    );
    expect(jobs).toHaveLength(2_000);
    expect(new Set(jobs.map(job => job.id)).size).toBe(2_000);
  }, 60_000);

  test("team concurrency gate: limit 2 admits 2, backlogs the rest, promotes on finish", async () => {
    const { queue } = await makeCtx("teamgate");
    const owner = freshOwner();
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const jobs = await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      })),
      gate(2),
    );

    expect(jobs.filter(j => j.status === "queued").length).toBe(2);
    expect(jobs.filter(j => j.status === "backlog").length).toBe(3);
    expect(await queue.getTeamActiveCount(owner)).toBe(2);
    expect(await queue.getTeamPendingCount(owner)).toBe(3);
    expect(await queue.getWorkerLoadCount()).toBe(2);

    const queuedMetrics = await queue.getMetrics();
    expect(queuedMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="queued"} 2`,
    );
    expect(queuedMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="active"} 0`,
    );
    expect(queuedMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="backlog"} 3`,
    );

    const taken = await takeAll(queue, 5);
    expect(taken.length).toBe(2);
    expect(await queue.getWorkerLoadCount()).toBe(2);

    const activeMetrics = await queue.getMetrics();
    expect(activeMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="queued"} 0`,
    );
    expect(activeMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="active"} 2`,
    );
    expect(activeMetrics).toContain(
      `nuq_fdb_queue_t_${RUN}_teamgate_job_count{status="backlog"} 3`,
    );

    // finishing one job promotes exactly one backlogged job
    await queue.jobFinish(taken[0].id, taken[0].lock!, null);
    expect(await queue.getTeamActiveCount(owner)).toBe(2);
    expect(await queue.getTeamPendingCount(owner)).toBe(2);

    const next = await takeAll(queue, 5);
    expect(next.length).toBe(1);

    await queue.jobFinish(taken[1].id, taken[1].lock!, null);
    await queue.jobFinish(next[0].id, next[0].lock!, null);
    const rest = await takeAll(queue, 5);
    expect(rest.length).toBe(2);
    for (const j of rest) await queue.jobFinish(j.id, j.lock!, null);
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    expect((await queue.getTeamActiveCounts()).has(owner)).toBe(false);
    await getNuqFdbDatabase().doTn(async tn => {
      expect(await tn.get(queue.ks.teamActiveIndex(owner))).toBeFalsy();
    });
  });

  test("metrics count pending teams even without active index entries", async () => {
    const { queue } = await makeCtx("pending-metrics");
    const owner = freshOwner();

    await queue.addJobs(
      Array.from({ length: 4 }, () => ({
        id: randomUUID(),
        data: scrapeData(),
        options: { ownerId: owner },
      })),
      gate(0),
    );

    const metrics = await queue.getMetrics();
    expect(metrics).toContain(
      `nuq_fdb_queue_t_${RUN}_pending_metrics_job_count{status="backlog"} 4`,
    );
  });

  test("fresh generation backfills legacy jobs and all terminal statuses", async () => {
    const { queue } = await makeCtx("metric-backfill");
    const prior = await queue.getMetricCounterBackfillStatus();
    expect(prior?.phase).toBe("ready");
    expect(
      await queue.invalidateMetricCounterGeneration(prior!.generation),
    ).toBe(true);

    const owner = freshOwner();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner },
      })),
      gate(1),
    );
    const [active] = await takeAll(queue, 1);
    // A release-A transition while control is absent must remain valid legacy
    // state and must not write into the invalidated generation.
    await queue.jobFinish(active.id, active.lock!, null);
    await expect(queue.getMetrics()).rejects.toThrow(
      "NuQ FDB metrics are initializing",
    );

    const building = await queue.beginMetricCounterBackfill();
    expect(building.phase).toBe("backfill-jobs");
    let initialized = false;
    for (let page = 0; page < 500 && !initialized; page++) {
      initialized = await queue.backfillMetricCounts(5);
    }
    expect(initialized).toBe(true);
    const metrics = await queue.getMetrics();
    expect(metrics).toContain(
      `nuq_fdb_queue_t_${RUN}_metric_backfill_job_count{status="queued"} 1`,
    );
    expect(metrics).toContain(
      `nuq_fdb_queue_t_${RUN}_metric_backfill_job_count{status="completed"} 1`,
    );
    expect(metrics).toContain(
      `nuq_fdb_queue_t_${RUN}_metric_backfill_job_count{status="backlog"} 1`,
    );
  });

  test("backfill pages raw legacy keys, survives cursor replay, and removes ledger orphans", async () => {
    const { queue } = await makeCtx("metric-cursors");
    const prior = await queue.getMetricCounterBackfillStatus();
    await queue.invalidateMetricCounterGeneration(prior!.generation);

    const owner = freshOwner();
    const statuses = [
      "pending",
      "queued",
      "active",
      "completed",
      "failed",
    ] as const;
    await getNuqFdbDatabase().doTn(async tn => {
      for (const status of statuses) {
        const id = `legacy-${status}`;
        tn.set(
          queue.ks.jobMeta(id),
          encodeJson({ c: Date.now(), p: 0, o: owner, f: 0, dc: 120 }),
        );
        tn.set(queue.ks.jobStatus(id), encodeJson({ s: status, st: 0 }));
        // Interleaved payload keys force many raw-key pages for one job.
        for (let chunk = 0; chunk < 120; chunk++) {
          tn.set(queue.ks.jobData(id, chunk), Buffer.from("x"));
        }
      }
      tn.set(
        queue.ks.jobMeta("legacy-cancelled"),
        encodeJson({ c: Date.now(), p: 0, o: owner, f: 0, dc: 0 }),
      );
      tn.set(
        queue.ks.jobStatus("legacy-cancelled"),
        encodeJson({ s: "cancelled", st: 0 }),
      );
      tn.set(
        queue.ks.jobMeta("legacy-ingesting"),
        encodeJson({ c: Date.now(), p: 0, o: owner, f: 0, dc: 0 }),
      );
      tn.set(
        queue.ks.jobStatus("legacy-ingesting"),
        encodeJson({ s: "ingesting", st: 0 }),
      );
      tn.set(
        queue.ks.jobStatus("status-only-tombstone"),
        encodeJson({ s: "queued", st: 0 }),
      );
      tn.set(
        queue.ks.jobMeta("meta-only-tombstone"),
        encodeJson({ c: Date.now(), p: 0, o: owner, f: 0, dc: 0 }),
      );
    });

    const building = await queue.beginMetricCounterBackfill();
    expect(await queue.backfillMetricCounts(7)).toBe(false);
    const cursor = await getNuqFdbDatabase().doTn(tn =>
      tn.get(queue.ks.metricJobsCursor(building.generation)),
    );
    expect(cursor).toBeTruthy();

    // Replay a committed page as if a process crashed before observing its
    // result. Status-valued membership makes the repeat exactly idempotent.
    await getNuqFdbDatabase().doTn(async tn => {
      const range = queue.ks.jobRootRange();
      tn.set(queue.ks.metricJobsCursor(building.generation), range.begin);
      const orphan = "000-ledger-orphan";
      tn.set(
        queue.ks.metricLedger(building.generation, orphan),
        Buffer.from("queued"),
      );
      tn.add(
        queue.ks.metricCount(
          building.generation,
          "queued",
          fnv1a(orphan) % METRIC_SHARDS,
        ),
        encodeI64(1),
      );
    });

    // A protocol-aware insertion behind the durable cursor self-enrolls. A
    // deletion during discovery atomically removes canonical state + ledger.
    const newId = "000-new-behind-cursor";
    await queue.addJob(newId, scrapeData(), { ownerId: owner }, UNLIMITED);
    expect(await queue.removeJob("legacy-failed")).toBe(true);

    await activateMetricGeneration(queue, 7);
    const invariant = await readMetricInvariant(queue);
    expect(invariant.ledger.get(newId)).toBe("queued");
    expect(invariant.ledger.has("legacy-failed")).toBe(false);
    expect(invariant.ledger.has("000-ledger-orphan")).toBe(false);
    expect(invariant.ledger.has("legacy-cancelled")).toBe(false);
    expect(invariant.ledger.has("legacy-ingesting")).toBe(false);
    expect(invariant.ledger.has("status-only-tombstone")).toBe(false);
    expect(invariant.counts).toEqual(countsFromLedger(invariant.ledger));
    expect(invariant.counts).toEqual({
      pending: 1,
      queued: 2,
      active: 1,
      completed: 1,
      failed: 0,
    });
  }, 60_000);

  test("activation conflicts converge and rollback invalidation fences stale generations", async () => {
    const { queue } = await makeCtx("metric-activation");
    const ready = await queue.getMetricCounterBackfillStatus();
    await queue.invalidateMetricCounterGeneration(ready!.generation);

    const controls = await Promise.all(
      Array.from({ length: 12 }, () => queue.beginMetricCounterBackfill()),
    );
    expect(new Set(controls.map(control => control.generation)).size).toBe(1);
    const firstGeneration = controls[0].generation;
    expect(
      await queue.invalidateMetricCounterGeneration("wrong-generation"),
    ).toBe(false);
    expect((await queue.getMetricCounterBackfillStatus())?.generation).toBe(
      firstGeneration,
    );
    expect(await queue.invalidateMetricCounterGeneration(firstGeneration)).toBe(
      true,
    );
    await expect(queue.getMetrics()).rejects.toThrow(
      "NuQ FDB metrics are initializing",
    );

    const next = await queue.beginMetricCounterBackfill();
    expect(next.generation).not.toBe(firstGeneration);
    await activateMetricGeneration(queue, 3);
    expect((await queue.getMetricCounterBackfillStatus())?.phase).toBe("ready");
  });

  test("randomized lifecycle preserves canonical ledger and exact counters", async () => {
    const { queue, sweeper } = await makeCtx("metric-randomized");
    const owner = freshOwner();
    const ids = Array.from(
      { length: 40 },
      (_, index) => `random-${String(index).padStart(3, "0")}`,
    );
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner },
      })),
      gate(13),
    );
    const active = await takeAll(queue, 13);
    for (let index = 0; index < active.length; index++) {
      if (index % 3 === 0) {
        await queue.jobFinish(active[index].id, active[index].lock!, null);
      } else if (index % 3 === 1) {
        await queue.jobFail(active[index].id, active[index].lock!, "failed");
      } else {
        await queue.removeJob(active[index].id);
      }
    }
    for (let index = 0; index < ids.length; index += 7) {
      await queue.removeJob(ids[index]);
    }
    await sweeper.sweepOnce();

    const invariant = await readMetricInvariant(queue);
    expect(invariant.counts).toEqual(countsFromLedger(invariant.ledger));
    for (const id of ids) {
      const job = await queue.getJob(id);
      const expected =
        job?.status === "backlog"
          ? "pending"
          : job?.status === "queued" ||
              job?.status === "active" ||
              job?.status === "completed" ||
              job?.status === "failed"
            ? job.status
            : undefined;
      expect(invariant.ledger.get(id)).toBe(expected);
    }
  }, 30_000);

  test("dequeue never waits for capped fire-and-forget claim cleanup", async () => {
    let cleanupCalls = 0;
    const never = new Promise<void>(() => {});
    const { queue } = await makeCtx("claim-cleanup-cap", {
      testHooks: {
        runClaimCleanup: async () => {
          cleanupCalls++;
          await never;
        },
      },
    });
    const ids = Array.from({ length: 12 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({ id, data: scrapeData(), options: {} })),
      UNLIMITED,
    );

    const startedAt = Date.now();
    const jobs = await takeAll(queue, ids.length);
    expect(jobs).toHaveLength(ids.length);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(cleanupCalls).toBe(8);
    expect(queue.getClaimCleanupInFlightForTest()).toBe(8);
    const claims = await getNuqFdbDatabase().doTn(async tn => {
      const range = queue.ks.claimRange();
      return await tn.snapshot().getRangeAll(range.begin, range.end);
    });
    expect(claims).toHaveLength(ids.length);
  });

  test("claim cleanup errors fall back to expiry GC without racing live markers", async () => {
    const { queue, sweeper } = await makeCtx("claim-cleanup-gc", {
      leaseMs: 80,
      testHooks: {
        runClaimCleanup: async () => {
          throw new Error("cleanup unavailable");
        },
      },
    });
    await queue.addJob(randomUUID(), scrapeData(), {}, UNLIMITED);
    const job = await queue.getJobToProcess();
    expect(job).not.toBeNull();

    const futureOp = randomUUID();
    const futureExpiry = Date.now() + 200;
    await getNuqFdbDatabase().doTn(async tn => {
      tn.set(
        queue.ks.claim(futureOp),
        encodeJson({ i: "future", l: "lock", e: futureExpiry }),
      );
      tn.set(queue.ks.claimExpiry(Date.now() - 1, futureOp), Buffer.alloc(0));
      tn.set(queue.ks.claimExpiry(futureExpiry, futureOp), Buffer.alloc(0));
    });
    await sweeper.sweepOnce();
    expect(
      await getNuqFdbDatabase().doTn(tn => tn.get(queue.ks.claim(futureOp))),
    ).toBeTruthy();

    await new Promise(resolve => setTimeout(resolve, 250));
    await sweeper.sweepOnce();
    const remaining = await getNuqFdbDatabase().doTn(async tn => {
      const claimRange = queue.ks.claimRange();
      const expiryRange = queue.ks.claimExpiryRange();
      return {
        claims: await tn
          .snapshot()
          .getRangeAll(claimRange.begin, claimRange.end),
        expiries: await tn
          .snapshot()
          .getRangeAll(expiryRange.begin, expiryRange.end),
      };
    });
    expect(remaining.claims).toEqual([]);
    expect(remaining.expiries).toEqual([]);
  });

  test("promotion respects priority order", async () => {
    const { queue } = await makeCtx("priority");
    const owner = freshOwner();
    const blocker = randomUUID();
    await queue.addJob(
      blocker,
      scrapeData(),
      { ownerId: owner, priority: 0 },
      gate(1),
    );
    const lowPrio = randomUUID();
    const highPrio = randomUUID();
    await queue.addJob(
      lowPrio,
      scrapeData(),
      {
        ownerId: owner,
        priority: 50,
        timesOutAt: new Date(Date.now() + 60_000),
      },
      gate(1),
    );
    await queue.addJob(
      highPrio,
      scrapeData(),
      {
        ownerId: owner,
        priority: 1,
        timesOutAt: new Date(Date.now() + 60_000),
      },
      gate(1),
    );

    const [b] = await takeAll(queue, 1);
    expect(b.id).toBe(blocker);
    await queue.jobFinish(b.id, b.lock!, null);

    const [promoted] = await takeAll(queue, 1);
    expect(promoted.id).toBe(highPrio);
  });

  test("kickoff jobs bypass the gate and hold no slot", async () => {
    const { queue } = await makeCtx("kickoff");
    const owner = freshOwner();
    const kickoff = randomUUID();
    await queue.addJob(
      kickoff,
      { mode: "kickoff", crawl_id: randomUUID() },
      { ownerId: owner, bypassGate: true },
      gate(1),
    );
    expect(await queue.getTeamActiveCount(owner)).toBe(0);

    const [k] = await takeAll(queue, 1);
    expect(k.id).toBe(kickoff);
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
    await queue.jobFinish(k.id, k.lock!, null);
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
  });

  test("QueueFullError when the backlog cap is exceeded", async () => {
    const { queue } = await makeCtx("qfull");
    const owner = freshOwner();
    const blocker = randomUUID();
    await queue.addJob(blocker, scrapeData(), { ownerId: owner }, gate(1, 2));
    // 1 active, cap 2: two backlogged jobs fit, the third addJobs blows up
    await queue.addJobs(
      [randomUUID(), randomUUID()].map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      })),
      gate(1, 2),
    );
    await expect(
      queue.addJob(
        randomUUID(),
        scrapeData(),
        { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
        gate(1, 2),
      ),
    ).rejects.toThrow(/queue limit reached/i);
  });

  test("a late queue-cap rejection releases partial ingest reservations", async () => {
    const { queue } = await makeCtx("qfull-bulk-abort");
    const owner = freshOwner();
    const ids = Array.from({ length: 300 }, () => randomUUID());
    await expect(
      queue.addJobs(
        ids.map(id => ({
          id,
          data: scrapeData(),
          options: { ownerId: owner },
        })),
        gate(0, 250),
      ),
    ).rejects.toThrow(/queue limit reached/i);
    await getNuqFdbDatabase().doTn(async tn => {
      expect(decodeI64(await tn.get(queue.ks.teamIngestReserved(owner)))).toBe(
        0,
      );
    });
    expect(await queue.getJobs(ids)).toEqual([]);
  });

  test("group lifecycle: numeric stats, finish detection, crawl_finished emission", async () => {
    const { queue, finishedQueue, group } = await makeCtx("glife");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);

    const ids = Array.from({ length: 3 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, groupId: gid },
      })),
      gate(10),
    );

    let stats = await queue.getGroupNumericStats(gid);
    expect(stats.queued).toBe(3);

    const taken = await takeAll(queue, 3);
    expect(taken.length).toBe(3);
    stats = await queue.getGroupNumericStats(gid);
    expect(stats.active).toBe(3);

    for (const j of taken.slice(0, 2))
      await queue.jobFinish(j.id, j.lock!, null);
    await queue.jobFail(taken[2].id, taken[2].lock!, "boom");

    stats = await queue.getGroupNumericStats(gid);
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.active).toBe(0);

    // the last terminal transition completes the group inline
    const g = await group.getGroup(gid);
    expect(g?.status).toBe("completed");
    expect(g?.expiresAt).toBeDefined();

    // and emits exactly one crawl_finished job
    const finishedJob = await finishedQueue.getJobToProcess();
    expect(finishedJob).not.toBeNull();
    expect(finishedJob!.groupId).toBe(gid);
    expect(await finishedQueue.getJobToProcess()).toBeNull();
    await finishedQueue.jobFinish(finishedJob!.id, finishedJob!.lock!, null);

    const ongoing = await group.getOngoingByOwner(owner);
    expect(ongoing.find(o => o.id === gid)).toBeUndefined();
  });

  test("crawl maxConcurrency gates within the team limit", async () => {
    const { queue, group } = await makeCtx("crawlmax");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner, undefined, { maxConcurrency: 1 });

    const ids = Array.from({ length: 3 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: {
          ownerId: owner,
          groupId: gid,
          timesOutAt: new Date(Date.now() + 60_000),
        },
      })),
      gate(10),
    );

    // only 1 crawl slot: one job ready, two crawl-pending
    expect(await queue.getTeamActiveCount(owner)).toBe(1);
    const taken1 = await takeAll(queue, 3);
    expect(taken1.length).toBe(1);

    await queue.jobFinish(taken1[0].id, taken1[0].lock!, null);
    const taken2 = await takeAll(queue, 3);
    expect(taken2.length).toBe(1);

    await queue.jobFinish(taken2[0].id, taken2[0].lock!, null);
    const taken3 = await takeAll(queue, 3);
    expect(taken3.length).toBe(1);
    await queue.jobFinish(taken3[0].id, taken3[0].lock!, null);

    const g = await group.getGroup(gid);
    expect(g?.status).toBe("completed");
  });

  test("crawl delay: next job is parked until the not-before time", async () => {
    const { queue, group, sweeper } = await makeCtx("delay");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner, undefined, { delaySeconds: 1 });

    const ids = [randomUUID(), randomUUID()];
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: {
          ownerId: owner,
          groupId: gid,
          timesOutAt: new Date(Date.now() + 60_000),
        },
      })),
      gate(10),
    );

    const [first] = await takeAll(queue, 2);
    expect(first).toBeDefined();
    await queue.jobFinish(first.id, first.lock!, null);

    // second job is in the delay index, not takeable yet
    await sweeper.sweepOnce();
    expect(await queue.getJobToProcess()).toBeNull();

    await new Promise(resolve => setTimeout(resolve, 1200));
    await sweeper.sweepOnce();
    const [second] = await takeAll(queue, 1);
    expect(second).toBeDefined();
    expect(second.id).toBe(ids.find(i => i !== first.id));
    await queue.jobFinish(second.id, second.lock!, null);
  });

  test("lease expiry: sweeper requeues a stalled job, then fails it after MAX_STALLS", async () => {
    const { queue, sweeper } = await makeCtx("stalls");
    const owner = freshOwner();
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: owner }, gate(5));

    const [job] = await takeAll(queue, 1);
    expect(job.id).toBe(id);

    // let the lease expire without renewal
    await new Promise(resolve => setTimeout(resolve, TEST_LEASE_MS + 200));
    await sweeper.sweepOnce();

    let j = await queue.getJob(id);
    expect(j?.status).toBe("queued");

    // Worker that lost its lease can neither renew nor finish. The conflictful
    // renewal read also enforces this when renewal races the sweeper commit.
    expect(await queue.renewLock(id, job.lock!)).toBe(false);
    expect(await queue.jobFinish(id, job.lock!, null)).toBe(false);

    // stall it to death
    for (let i = 0; i < 9; i++) {
      const [again] = await takeAll(queue, 1);
      expect(again.id).toBe(id);
      await new Promise(resolve => setTimeout(resolve, TEST_LEASE_MS + 200));
      await sweeper.sweepOnce();
    }
    j = await queue.getJob(id);
    expect(j?.status).toBe("failed");
    expect(j?.failedReason).toMatch(/stalled/i);
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
  }, 60_000);

  test("renewLock keeps the lease alive", async () => {
    const { queue, sweeper } = await makeCtx("renew");
    const owner = freshOwner();
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: owner }, gate(5));
    const [job] = await takeAll(queue, 1);

    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, TEST_LEASE_MS / 2));
      expect(await queue.renewLock(id, job.lock!)).toBe(true);
    }
    await sweeper.sweepOnce();
    const j = await queue.getJob(id);
    expect(j?.status).toBe("active");
    expect(await queue.jobFinish(id, job.lock!, null)).toBe(true);
  }, 30_000);

  test("renewLock conflicts cleanly with a concurrent finish", async () => {
    const { queue, sweeper } = await makeCtx("renew-finish-race");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = randomUUID();
      ids.push(id);
      await queue.addJob(
        id,
        scrapeData(),
        { ownerId: freshOwner() },
        UNLIMITED,
      );
      const job = await queue.getJobToProcess();
      const [renewed, finished] = await Promise.all([
        queue.renewLock(id, job!.lock!),
        queue.jobFinish(id, job!.lock!, null),
      ]);
      expect(finished).toBe(true);
      expect(typeof renewed).toBe("boolean");
      expect((await queue.getJob(id))?.status).toBe("completed");
    }
    // One pass after all races is sufficient to prove none of the stale lease
    // rows can resurrect any concurrently completed job.
    await sweeper.sweepOnce();
    for (const id of ids) {
      expect((await queue.getJob(id))?.status).toBe("completed");
    }
  }, 30_000);

  test("renewLock cannot resurrect a concurrently reaped lease", async () => {
    const { queue, sweeper } = await makeCtx("renew-reap-race", {
      leaseMs: 100,
    });
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: freshOwner() }, UNLIMITED);
    const original = await queue.getJobToProcess();
    await new Promise(resolve => setTimeout(resolve, 150));

    const [renewed] = await Promise.all([
      queue.renewLock(id, original!.lock!),
      sweeper.sweepOnce(),
    ]);
    const after = await queue.getJob(id);
    expect(["active", "queued"]).toContain(after?.status);
    if (after?.status === "active") {
      expect(renewed).toBe(true);
      expect(await queue.jobFinish(id, original!.lock!, null)).toBe(true);
    } else {
      expect(renewed).toBe(false);
      expect(await queue.jobFinish(id, original!.lock!, null)).toBe(false);
      const retried = await queue.getJobToProcess();
      expect(await queue.jobFinish(id, retried!.lock!, null)).toBe(true);
    }
    expect((await queue.getJob(id))?.status).toBe("completed");
  });

  test("backlog timeout: pending jobs are silently dropped at their deadline", async () => {
    const { queue, sweeper } = await makeCtx("bto");
    const owner = freshOwner();
    const blocker = randomUUID();
    await queue.addJob(blocker, scrapeData(), { ownerId: owner }, gate(1));
    const doomed = randomUUID();
    await queue.addJob(
      doomed,
      scrapeData(),
      { ownerId: owner, timesOutAt: new Date(Date.now() - 1000) },
      gate(1),
    );

    expect(await queue.getTeamPendingCount(owner)).toBe(1);
    await sweeper.sweepOnce();
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    expect(await queue.getJob(doomed)).toBeNull();

    const [b] = await takeAll(queue, 1);
    await queue.jobFinish(b.id, b.lock!, null);
  });

  test("group cancellation: pending dropped, ready diverted, group still completes", async () => {
    const { queue, finishedQueue, group, sweeper } = await makeCtx("cancel");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);

    const ids = Array.from({ length: 4 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: {
          ownerId: owner,
          groupId: gid,
          timesOutAt: new Date(Date.now() + 60_000),
        },
      })),
      gate(2),
    );
    // 2 ready, 2 team-pending
    const [active] = await takeAll(queue, 1);

    expect(await group.cancelGroup(gid)).toBe(true);
    await sweeper.sweepOnce(); // cleans pending members

    // the remaining ready job is diverted at take time
    const after = await takeAll(queue, 4);
    expect(after.length).toBe(0);

    // active job finishes normally; that drains the group
    await queue.jobFinish(active.id, active.lock!, null);
    await sweeper.sweepOnce();

    const g = await group.getGroup(gid);
    expect(g?.status).toBe("completed");
    expect(await queue.getTeamActiveCount(owner)).toBe(0);

    // cancelled crawls still emit their crawl_finished job
    const fin = await finishedQueue.getJobToProcess();
    expect(fin).not.toBeNull();
    expect(fin!.groupId).toBe(gid);
    await finishedQueue.jobFinish(fin!.id, fin!.lock!, null);
  });

  test("group cancellation drains past 25k stale index rows", async () => {
    const { queue, group, sweeper } = await makeCtx("cancel-stale-index");
    const db = getNuqFdbDatabase();
    const owner = freshOwner();
    const gid = randomUUID();
    const pendingId = "zzzz-real-pending";
    await group.addGroup(gid, owner);

    await db.doTn(async tn => {
      for (let i = 0; i < 25_100; i++) {
        tn.set(
          queue.ks.groupJob(gid, `0000-stale-${String(i).padStart(4, "0")}`),
          encodeJson({ m: 1, s: "pending" }),
        );
      }
    });

    await queue.addJob(
      pendingId,
      scrapeData(),
      {
        ownerId: owner,
        groupId: gid,
        timesOutAt: new Date(Date.now() + 60_000),
      },
      gate(0),
    );
    expect(await queue.getTeamPendingCount(owner)).toBe(1);

    expect(await group.cancelGroup(gid)).toBe(true);
    await sweeper.sweepOnce();
    if ((await queue.getTeamPendingCount(owner)) > 0) {
      await getNuqFdbDatabase().doTn(async tn => {
        expect(await tn.get(queue.ks.taskGroupCancel(gid))).toBeTruthy();
      });
      await sweeper.sweepOnce();
    }

    expect(await queue.getJob(pendingId)).toBeNull();
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    await db.doTn(async tn => {
      expect(await tn.get(queue.ks.taskGroupCancel(gid))).toBeFalsy();
    });
  }, 60_000);

  test("waitForJob resolves on completion and rejects on failure", async () => {
    const { queue } = await makeCtx("wait");
    const owner = freshOwner();
    const id1 = randomUUID();
    await queue.addJob(id1, scrapeData(), { ownerId: owner }, UNLIMITED);

    const wait1 = queue.waitForJob(id1, 15_000);
    const [j1] = await takeAll(queue, 1);
    await queue.jobFinish(j1.id, j1.lock!, { doc: "ok" });
    if (expectInlineReturnvalue) {
      await expect(wait1).resolves.toEqual({ doc: "ok" });
    } else {
      await expect(wait1).resolves.toBeNull();
    }

    const id2 = randomUUID();
    await queue.addJob(id2, scrapeData(), { ownerId: owner }, UNLIMITED);
    const wait2 = queue.waitForJob(id2, 15_000);
    const [j2] = await takeAll(queue, 1);
    await queue.jobFail(j2.id, j2.lock!, "scrape exploded");
    await expect(wait2).rejects.toThrow("scrape exploded");

    const id3 = randomUUID();
    await queue.addJob(id3, scrapeData(), { ownerId: owner }, UNLIMITED);
    await expect(queue.waitForJob(id3, 500)).rejects.toThrow(/timed out/i);
    const [j3] = await takeAll(queue, 1);
    await queue.jobFinish(j3.id, j3.lock!, null);
  }, 30_000);

  test("large returnvalue is chunked and reassembled (self-host path)", async () => {
    if (!expectInlineReturnvalue) return;
    const { queue } = await makeCtx("chunks");
    const owner = freshOwner();
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: owner }, UNLIMITED);
    const [job] = await takeAll(queue, 1);

    const big = { blob: "x".repeat(300 * 1024) };
    await queue.jobFinish(id, job.lock!, big);

    const j = await queue.getJob(id);
    expect(j?.status).toBe("completed");
    expect(j?.returnvalue?.blob?.length).toBe(300 * 1024);
  });

  test("self-host values and UTF-8 failure reasons stay within FDB bounds", async () => {
    if (!expectInlineReturnvalue) return;
    const { queue } = await makeCtx("value-bounds");
    const owner = freshOwner();

    const completedId = randomUUID();
    await queue.addJob(
      completedId,
      scrapeData(),
      { ownerId: owner },
      UNLIMITED,
    );
    const completed = await queue.getJobToProcess();
    expect(
      await queue.jobFinish(completedId, completed!.lock!, {
        blob: "x".repeat(9 * 1024 * 1024),
      }),
    ).toBe(true);
    expect((await queue.getJob(completedId))?.returnvalue).toBeNull();

    const failedId = randomUUID();
    await queue.addJob(failedId, scrapeData(), { ownerId: owner }, UNLIMITED);
    const failed = await queue.getJobToProcess();
    await queue.jobFail(failedId, failed!.lock!, "🔥".repeat(100_000));
    const reason = (await queue.getJob(failedId))?.failedReason ?? "";
    expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(90 * 1024);
    expect(reason.endsWith("�")).toBe(false);
  }, 30_000);

  test("getCrawlJobsForListing paginates completed jobs in finish order", async () => {
    const { queue, group } = await makeCtx("listing");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);

    const ids = Array.from({ length: 5 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, groupId: gid },
      })),
      gate(10),
    );
    const taken = await takeAll(queue, 5);
    expect(taken.length).toBe(5);
    const finishOrder: string[] = [];
    for (const j of taken) {
      await queue.jobFinish(j.id, j.lock!, null);
      finishOrder.push(j.id);
    }

    const page1 = await queue.getCrawlJobsForListing(gid, 3, 0);
    const page2 = await queue.getCrawlJobsForListing(gid, 3, 3);
    expect(page1.map(j => j.id)).toEqual(finishOrder.slice(0, 3));
    expect(page2.map(j => j.id)).toEqual(finishOrder.slice(3));
  });

  test("crawl listing handles deep offsets in bounded transactions", async () => {
    const { queue } = await makeCtx("listing-deep");
    const db = getNuqFdbDatabase();
    const owner = freshOwner();
    const gid = randomUUID();
    const ids = Array.from(
      { length: 1205 },
      (_, i) => `deep-${String(i).padStart(4, "0")}`,
    );

    for (let start = 0; start < ids.length; start += 100) {
      await db.doTn(async tn => {
        const txc = newTxContext();
        for (const id of ids.slice(start, start + 100)) {
          tn.set(
            queue.ks.jobMeta(id),
            encodeJson({ c: Date.now(), p: 0, o: owner, g: gid, f: 0, dc: 1 }),
          );
          tn.set(
            queue.ks.jobStatus(id),
            encodeJson({ s: "completed", st: 0, fa: Date.now() }),
          );
          tn.set(queue.ks.jobData(id, 0), encodeJson(scrapeData()));
          tn.setVersionstampSuffixedKey(
            queue.ks.groupDonePrefix(gid),
            Buffer.from(id),
            uvSuffix(txc),
          );
        }
      });
    }

    const page = await queue.getCrawlJobsForListing(gid, 5, 1200);
    expect(page.map(job => job.id)).toEqual(ids.slice(1200));
  });

  test("getGroupAnyJob returns a single_urls member and checks ownership", async () => {
    const { queue, group } = await makeCtx("anyjob");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);
    const id = randomUUID();
    await queue.addJob(
      id,
      scrapeData(),
      { ownerId: owner, groupId: gid },
      gate(10),
    );

    const any = await queue.getGroupAnyJob(gid, owner);
    expect(any?.id).toBe(id);
    expect(await queue.getGroupAnyJob(gid, randomUUID())).toBeNull();

    const [j] = await takeAll(queue, 1);
    await queue.jobFinish(j.id, j.lock!, null);
  });

  test("getGroupAnyJob scans beyond deep non-countable prefixes", async () => {
    const { queue, group } = await makeCtx("anyjob-deep");
    const owner = freshOwner();
    const gid = randomUUID();
    const id = "zzzz-countable-member";
    await group.addGroup(gid, owner);
    await getNuqFdbDatabase().doTn(async tn => {
      for (let i = 0; i < 2100; i++) {
        tn.set(
          queue.ks.groupJob(
            gid,
            `0000-non-countable-${String(i).padStart(4, "0")}`,
          ),
          encodeJson({ m: 0, s: "completed" }),
        );
      }
    });
    await queue.addJob(
      id,
      scrapeData(),
      { ownerId: owner, groupId: gid },
      gate(10),
    );

    expect((await queue.getGroupAnyJob(gid, owner))?.id).toBe(id);
    const job = await queue.getJobToProcess();
    await queue.jobFinish(job!.id, job!.lock!, null);
  });

  // A completed crawl member must retain its input data so the crawl-finish job
  // can recover crawl-scoped context (v1, webhook, team_id) via getGroupAnyJob,
  // matching the PG backend. Cloud sheds standalone data but not group members.
  test("group member retains input data after completion", async () => {
    const { queue, group } = await makeCtx("retain-groupdata");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);
    const id = randomUUID();
    await queue.addJob(
      id,
      scrapeData({ v1: true, team_id: owner, webhook: { url: "https://wh" } }),
      { ownerId: owner, groupId: gid },
      gate(10),
    );

    const [j] = await takeAll(queue, 1);
    await queue.jobFinish(j.id, j.lock!, { ok: true });

    const any = await queue.getGroupAnyJob(gid, owner);
    expect(any?.id).toBe(id);
    expect(any?.data).not.toBeNull();
    expect(any?.data?.v1).toBe(true);
    expect(any?.data?.webhook?.url).toBe("https://wh");
  });

  // ZDR members still shed input data on completion (compliance), so the
  // crawl-finish path must tolerate null data for those crawls.
  test("ZDR group member sheds input data on completion", async () => {
    const { queue, group } = await makeCtx("zdr-shed");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner);
    const id = randomUUID();
    await queue.addJob(
      id,
      scrapeData({ zeroDataRetention: true }),
      { ownerId: owner, groupId: gid },
      gate(10),
    );

    const [j] = await takeAll(queue, 1);
    await queue.jobFinish(j.id, j.lock!, null);

    const got = await queue.getJob(id);
    expect(got?.data).toBeNull();
  });

  test("removeJob releases slots and promotes backlog", async () => {
    const { queue } = await makeCtx("remove");
    const owner = freshOwner();
    const a = randomUUID();
    const b = randomUUID();
    await queue.addJob(a, scrapeData(), { ownerId: owner }, gate(1));
    await queue.addJob(
      b,
      scrapeData(),
      { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      gate(1),
    );
    expect(await queue.getTeamPendingCount(owner)).toBe(1);

    // removing the slot-holding job promotes the backlogged one
    expect(await queue.removeJob(a)).toBe(true);
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    expect(await queue.getJob(a)).toBeNull();

    const [j] = await takeAll(queue, 1);
    expect(j.id).toBe(b);
    await queue.jobFinish(j.id, j.lock!, null);
  });

  test("removeJobs deduplicates and removes mixed ready/backlog jobs in bounded parallel batches", async () => {
    const { queue, group, sweeper } = await makeCtx("remove-many");
    const owner = freshOwner();
    const gid = randomUUID();
    const ids = Array.from({ length: 40 }, () => randomUUID());
    await group.addGroup(gid, owner);
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, groupId: gid },
      })),
      gate(10),
    );

    await queue.removeJobs([...ids, ...ids.slice(0, 10)]);
    await sweeper.sweepOnce();
    expect(await queue.getTeamActiveCount(owner)).toBe(0);
    expect(await queue.getTeamPendingCount(owner)).toBe(0);
    expect(await queue.getJobToProcess()).toBeNull();
    expect((await group.getGroup(gid))?.status).toBe("completed");
  });

  test("limit raise promotes backlogged jobs via the sweeper", async () => {
    const { queue, sweeper } = await makeCtx("raise");
    const owner = freshOwner();
    const ids = Array.from({ length: 4 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      })),
      gate(1),
    );
    expect(await queue.getTeamActiveCount(owner)).toBe(1);
    expect(await queue.getTeamPendingCount(owner)).toBe(3);

    // a later enqueue arrives with a raised limit (ACUC change)
    await queue.addJob(
      randomUUID(),
      scrapeData(),
      { ownerId: owner, timesOutAt: new Date(Date.now() + 60_000) },
      gate(4),
    );
    await sweeper.sweepOnce();

    expect(await queue.getTeamActiveCount(owner)).toBe(4);
    expect(await queue.getTeamPendingCount(owner)).toBe(1);

    const taken = await takeAll(queue, 4);
    expect(taken.length).toBe(4);
    for (const j of taken) await queue.jobFinish(j.id, j.lock!, null);
    const [last] = await takeAll(queue, 1);
    await queue.jobFinish(last.id, last.lock!, null);
  });

  test("parallel releases converge exactly after a team limit is lowered", async () => {
    const { queue } = await makeCtx("limit-lower");
    const owner = freshOwner();
    const ids = Array.from({ length: 20 }, () => randomUUID());
    await queue.addJobs(
      ids.map(id => ({
        id,
        data: scrapeData(),
        options: { ownerId: owner },
      })),
      gate(10),
    );
    const active = await takeAll(queue, 10);
    expect(active).toHaveLength(10);

    await queue.addJob(randomUUID(), scrapeData(), { ownerId: owner }, gate(2));
    await Promise.all(
      active.map(job => queue.jobFinish(job.id, job.lock!, null)),
    );
    expect(await queue.getTeamActiveCount(owner)).toBe(2);
    const promoted = await takeAll(queue, 10);
    expect(promoted).toHaveLength(2);
  });

  test("group TTL cleanup resumes after more than 40k members", async () => {
    const { queue, finishedQueue, group, sweeper } = await makeCtx("gttl");
    const owner = freshOwner();
    const gid = randomUUID();
    await group.addGroup(gid, owner, 1000); // 1s TTL

    const id = randomUUID();
    await queue.addJob(
      id,
      scrapeData(),
      { ownerId: owner, groupId: gid },
      gate(10),
    );
    const [j] = await takeAll(queue, 1);
    await queue.jobFinish(j.id, j.lock!, null);

    expect((await group.getGroup(gid))?.status).toBe("completed");
    const control = await finishedQueue.getJobToProcess();
    expect(control?.groupId).toBe(gid);
    await finishedQueue.jobFinish(control!.id, control!.lock!, null);

    for (let start = 0; start < 40_001; start += 5_000) {
      await getNuqFdbDatabase().doTn(async tn => {
        for (let i = start; i < Math.min(start + 5_000, 40_001); i++) {
          tn.set(
            queue.ks.groupJob(gid, `synthetic-${String(i).padStart(5, "0")}`),
            encodeJson({ m: 0, s: "completed" }),
          );
        }
      });
    }
    await new Promise(resolve => setTimeout(resolve, 1100));
    await sweeper.sweepOnce();
    if (await group.getGroup(gid)) await sweeper.sweepOnce();

    expect(await group.getGroup(gid)).toBeNull();
    expect(await queue.getJob(id)).toBeNull();
  }, 60_000);
});
