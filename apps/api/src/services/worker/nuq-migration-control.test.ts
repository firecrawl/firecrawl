import { describe, expect, test, vi } from "vitest";
import type {
  MigrationObjectPin,
  MigrationTeamState,
} from "./nuq-fdb/migration-store";
import {
  DurableNuQPgPublicationAdapter,
  discoverLegacyTeamBackend,
  hasLegacyFdbTeamResidue,
  reconcileDesiredTeamBackend,
  reconcileFdbResidueFence,
  reconcilePgResidueFence,
  recoverLegacyTeamState,
  resolveAuthoritativeObjectBackend,
  stableTransitionOperationId,
  type NuQMigrationStorePort,
} from "./nuq-migration-control";

function state(
  overrides: Partial<MigrationTeamState> = {},
): MigrationTeamState {
  return {
    schemaVersion: 1,
    teamId: "team",
    revision: 1,
    maxGeneration: 1,
    activeBackend: "pg",
    activeGeneration: 1,
    phase: "PG_ONLY",
    ...overrides,
  };
}

function pin(
  objectId: string,
  overrides: Partial<MigrationObjectPin> = {},
): MigrationObjectPin {
  const zero = {
    capacity_team_pending: 0,
    capacity_key_pending: 0,
    capacity_crawl_pending: 0,
    capacity_delayed: 0,
    capacity_ready_active: 0,
    capacity_external_holders: 0,
    control_groups: 0,
    control_crawl_finished: 0,
    control_sweeper_tasks: 0,
    intent_unresolved: 1,
  };
  return {
    schemaVersion: 1,
    teamId: "team",
    kind: "scrape_job",
    objectId,
    backend: "pg",
    generation: 1,
    lifecycle: "prepared",
    revision: 1,
    admission: "new-root",
    initialResidue: zero,
    residue: zero,
    ...overrides,
  };
}

function storeMock(
  overrides: Partial<NuQMigrationStorePort> = {},
): NuQMigrationStorePort {
  return {
    inspectState: vi.fn(),
    resolveSteady: vi.fn(),
    initializeLegacyTeam: vi.fn(),
    beginTransition: vi.fn(),
    cancelTransition: vi.fn(),
    finalSeal: vi.fn(),
    inspectTeamPinsPage: vi.fn(),
    inspectPin: vi.fn(),
    preparePinnedObject: vi.fn(),
    preparePinnedObjects: vi.fn(),
    transitionObjectResidue: vi.fn(),
    completePinnedObject: vi.fn(),
    ...overrides,
  } as NuQMigrationStorePort;
}

describe("durable team state decisions", () => {
  test("uninitialized teams use caller-discovered FDB authority", async () => {
    const recovered = state({
      activeBackend: "fdb",
      phase: "FDB_ONLY",
    });
    const store = storeMock({
      resolveSteady: vi.fn().mockResolvedValue({
        status: "legacy-uninitialized",
      }),
      initializeLegacyTeam: vi.fn().mockResolvedValue(recovered),
    });
    const discover = vi.fn().mockResolvedValue("fdb");

    await expect(
      reconcileDesiredTeamBackend(store, "team", "fdb", discover),
    ).resolves.toEqual(recovered);
    expect(discover).toHaveBeenCalledOnce();
    expect(store.initializeLegacyTeam).toHaveBeenCalledWith(
      "team",
      "fdb",
      "nuq-router/v1/team/team/initialize/fdb",
      { ifAbsent: true },
    );
  });

  test("initialize-if-absent trusts a concurrent durable winner", async () => {
    const winner = state({
      revision: 2,
      maxGeneration: 2,
      activeBackend: "fdb",
      activeGeneration: 1,
      phase: "DRAINING_TO_PG",
      targetBackend: "pg",
      targetGeneration: 2,
      transitionOperationId: "winner",
    });
    const store = storeMock({
      resolveSteady: vi.fn().mockResolvedValue({
        status: "legacy-uninitialized",
      }),
      inspectState: vi.fn().mockResolvedValue(null),
      initializeLegacyTeam: vi.fn().mockResolvedValue(winner),
    });

    await expect(
      reconcileDesiredTeamBackend(store, "team", "pg", async () => "pg"),
    ).resolves.toEqual(winner);
    expect(store.initializeLegacyTeam).toHaveBeenCalledWith(
      "team",
      "pg",
      "nuq-router/v1/team/team/initialize/pg",
      { ifAbsent: true },
    );
    expect(store.beginTransition).not.toHaveBeenCalled();
    expect(store.cancelTransition).not.toHaveBeenCalled();
  });

  test("router bootstrap recovery returns an existing transitional winner unchanged", async () => {
    const winner = state({
      revision: 2,
      maxGeneration: 2,
      activeBackend: "fdb",
      activeGeneration: 1,
      phase: "DRAINING_TO_PG",
      targetBackend: "pg",
      targetGeneration: 2,
      transitionOperationId: "winner",
    });
    const discover = vi.fn().mockResolvedValue("pg");
    const store = storeMock({
      inspectState: vi.fn().mockResolvedValue(winner),
    });

    await expect(
      recoverLegacyTeamState(store, "team", discover),
    ).resolves.toEqual(winner);
    expect(discover).not.toHaveBeenCalled();
    expect(store.initializeLegacyTeam).not.toHaveBeenCalled();
    expect(store.beginTransition).not.toHaveBeenCalled();
    expect(store.cancelTransition).not.toHaveBeenCalled();
  });

  test("flag changes begin with stable operation IDs and fail admission retryably", async () => {
    const current = state();
    const store = storeMock({
      resolveSteady: vi.fn().mockResolvedValue({
        status: "transition-required",
        state: current,
      }),
      beginTransition: vi.fn().mockResolvedValue(
        state({
          revision: 2,
          maxGeneration: 2,
          phase: "DRAINING_TO_FDB",
          targetBackend: "fdb",
          targetGeneration: 2,
          transitionOperationId: stableTransitionOperationId(current, "fdb"),
        }),
      ),
    });

    await expect(
      reconcileDesiredTeamBackend(store, "team", "fdb", async () => "pg"),
    ).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
      retryable: true,
    });
    expect(store.beginTransition).toHaveBeenCalledWith({
      teamId: "team",
      targetBackend: "fdb",
      operationId: "nuq-router/v1/team/team/after-generation/1/to/fdb",
      expectedRevision: 1,
    });
  });

  test("a flag flap cancels the same durable transition operation", async () => {
    const draining = state({
      revision: 2,
      maxGeneration: 2,
      phase: "DRAINING_TO_FDB",
      targetBackend: "fdb",
      targetGeneration: 2,
      transitionOperationId: "stable-transition",
    });
    const cancelled = state({ revision: 3, maxGeneration: 2 });
    const store = storeMock({
      resolveSteady: vi.fn().mockResolvedValue({
        status: "cancel-required",
        state: draining,
      }),
      cancelTransition: vi.fn().mockResolvedValue(cancelled),
    });

    await expect(
      reconcileDesiredTeamBackend(store, "team", "pg", async () => "pg"),
    ).resolves.toEqual(cancelled);
    expect(store.cancelTransition).toHaveBeenCalledWith({
      teamId: "team",
      transitionOperationId: "stable-transition",
      expectedRevision: 2,
    });
  });
});

describe("legacy team authority discovery", () => {
  test("crawl-finished-only FDB residue is not classified empty", () => {
    expect(
      hasLegacyFdbTeamResidue({
        scrapePending: 0,
        scrapeActive: 0,
        scrapeIndexedLive: false,
        crawlFinishedPending: 0,
        crawlFinishedActive: 0,
        crawlFinishedIndexedLive: true,
        activeGroups: 0,
      }),
    ).toBe(true);
  });

  test("FDB residue recovers FDB authority instead of defaulting to PG", async () => {
    await expect(
      discoverLegacyTeamBackend({
        teamId: "team",
        probeFdbResidue: vi.fn().mockResolvedValue(true),
        probePgResidue: vi.fn().mockResolvedValue(false),
        emptyBackend: "pg",
      }),
    ).resolves.toBe("fdb");
  });

  test("both-present is corruption", async () => {
    await expect(
      discoverLegacyTeamBackend({
        teamId: "team",
        probeFdbResidue: vi.fn().mockResolvedValue(true),
        probePgResidue: vi.fn().mockResolvedValue(true),
        emptyBackend: "pg",
      }),
    ).rejects.toMatchObject({ code: "NUQ_ROUTER_BOTH_BACKENDS_PRESENT" });
  });

  test("FDB unavailability is retryable and never probes PG", async () => {
    const probePgResidue = vi.fn().mockResolvedValue(true);
    await expect(
      discoverLegacyTeamBackend({
        teamId: "team",
        probeFdbResidue: vi.fn().mockRejectedValue(new Error("FDB down")),
        probePgResidue,
        emptyBackend: "pg",
      }),
    ).rejects.toMatchObject({
      code: "NUQ_ROUTER_FDB_UNAVAILABLE",
      retryable: true,
    });
    expect(probePgResidue).not.toHaveBeenCalled();
  });
});

describe("authoritative backend resolution", () => {
  const base = {
    kind: "scrape_job" as const,
    objectId: "job",
    readPin: vi.fn().mockResolvedValue(null),
    probeFdb: vi.fn().mockResolvedValue(false),
    probePg: vi.fn().mockResolvedValue(false),
  };

  test("a corrupt marker is repaired when exactly one backend contains the job", async () => {
    const repairMarker = vi.fn();
    await expect(
      resolveAuthoritativeObjectBackend({
        ...base,
        marker: "corrupt",
        probePg: vi.fn().mockResolvedValue(true),
        repairMarker,
      }),
    ).resolves.toBe("pg");
    expect(repairMarker).toHaveBeenCalledWith("pg");
  });

  test("failed Redis hint repair cannot override an authoritative result", async () => {
    await expect(
      resolveAuthoritativeObjectBackend({
        ...base,
        marker: null,
        probeFdb: vi.fn().mockResolvedValue(true),
        repairMarker: vi.fn().mockRejectedValue(new Error("Redis down")),
      }),
    ).resolves.toBe("fdb");
  });

  test("both-present is deterministic even when the marker names one backend", async () => {
    await expect(
      resolveAuthoritativeObjectBackend({
        ...base,
        marker: "pg",
        probeFdb: vi.fn().mockResolvedValue(true),
        probePg: vi.fn().mockResolvedValue(true),
      }),
    ).rejects.toMatchObject({ code: "NUQ_ROUTER_BOTH_BACKENDS_PRESENT" });
  });

  test("a live pin with no backend object is unresolved, never silently routed", async () => {
    await expect(
      resolveAuthoritativeObjectBackend({
        ...base,
        marker: "pg",
        readPin: vi.fn().mockResolvedValue(
          pin("job", {
            lifecycle: "active",
            residue: { ...pin("job").residue, capacity_ready_active: 1 },
          }),
        ),
      }),
    ).rejects.toMatchObject({
      code: "NUQ_ROUTER_LIVE_PIN_OBJECT_MISSING",
      retryable: true,
    });
  });

  test("a terminal tombstone remains authoritative after object retention", async () => {
    await expect(
      resolveAuthoritativeObjectBackend({
        ...base,
        marker: null,
        readPin: vi.fn().mockResolvedValue(
          pin("job", {
            lifecycle: "terminal",
            residue: { ...pin("job").residue, intent_unresolved: 0 },
          }),
        ),
      }),
    ).resolves.toBe("pg");
  });

  test("a stale valid marker is cleared and fails deterministically", async () => {
    const repairMarker = vi.fn();
    await expect(
      resolveAuthoritativeObjectBackend({
        ...base,
        marker: "fdb",
        repairMarker,
      }),
    ).rejects.toMatchObject({ code: "NUQ_ROUTER_STALE_BACKEND_MARKER" });
    expect(repairMarker).toHaveBeenCalledWith(null);
  });

  test("corrupt marker without an authoritative record is deterministic", async () => {
    await expect(
      resolveAuthoritativeObjectBackend({ ...base, marker: "corrupt" }),
    ).rejects.toMatchObject({ code: "NUQ_ROUTER_CORRUPT_BACKEND_MARKER" });
  });

  test("FDB unavailability never probes or falls back to PG", async () => {
    const probePg = vi.fn().mockResolvedValue(true);
    await expect(
      resolveAuthoritativeObjectBackend({
        ...base,
        marker: null,
        readPin: vi.fn().mockRejectedValue(new Error("FDB down")),
        probePg,
      }),
    ).rejects.toMatchObject({
      code: "NUQ_ROUTER_FDB_UNAVAILABLE",
      retryable: true,
    });
    expect(probePg).not.toHaveBeenCalled();
  });
});

test("PG residue reconciliation changes only the durable seal fence", async () => {
  const existing = pin("pg-residue/team/generation/1", {
    kind: "cross_store_intent",
    residue: { ...pin("unused").residue, intent_unresolved: 1 },
  });
  const store = storeMock({
    inspectState: vi.fn().mockResolvedValue(state()),
    inspectPin: vi.fn().mockResolvedValue(existing),
    transitionObjectResidue: vi.fn().mockImplementation(async input => ({
      ...existing,
      residue: {
        ...existing.residue,
        intent_unresolved: input.residue.intent_unresolved ?? 0,
      },
    })),
  });

  await expect(
    reconcilePgResidueFence(store, {
      teamId: "team",
      total: 0,
      observationId: "pg-snapshot-2",
    }),
  ).resolves.toMatchObject({ residue: { intent_unresolved: 0 } });
  expect(store.transitionObjectResidue).toHaveBeenCalledWith({
    teamId: "team",
    kind: "cross_store_intent",
    objectId: "pg-residue/team/generation/1",
    operationId: "nuq-router/v1/pg-residue/pg-snapshot-2/pin-revision/1",
    fromLifecycle: "prepared",
    toLifecycle: "prepared",
    residue: { intent_unresolved: 0 },
    expectedRevision: 1,
  });
  expect(store.finalSeal).not.toHaveBeenCalled();
});

test("source residue commit-unknown retry replays its exact bounded operation", async () => {
  const existing = pin("pg-residue/team/generation/1", {
    kind: "cross_store_intent",
    revision: 2,
    residue: { ...pin("unused").residue, intent_unresolved: 0 },
    lastOperation: {
      schemaVersion: 1,
      operationId: "nuq-router/v1/pg-residue/stable-observation/pin-revision/1",
      fromLifecycle: "prepared",
      toLifecycle: "prepared",
      residue: { ...pin("unused").residue, intent_unresolved: 0 },
      resultRevision: 2,
    },
  });
  const transitionObjectResidue = vi.fn().mockResolvedValue(existing);
  const store = storeMock({
    inspectState: vi.fn().mockResolvedValue(state()),
    inspectPin: vi.fn().mockResolvedValue(existing),
    transitionObjectResidue,
  });

  await reconcilePgResidueFence(store, {
    teamId: "team",
    total: 0,
    observationId: "stable-observation",
  });
  expect(transitionObjectResidue).toHaveBeenCalledWith(
    expect.objectContaining({
      operationId: "nuq-router/v1/pg-residue/stable-observation/pin-revision/1",
      expectedRevision: 1,
    }),
  );
});

test("PG residue fence explicitly adopts the draining source generation", async () => {
  const adopted = pin("pg-residue/team/generation/1", {
    kind: "cross_store_intent",
    admission: "legacy-backfill",
  });
  const store = storeMock({
    inspectPin: vi.fn().mockResolvedValue(null),
    inspectState: vi.fn().mockResolvedValue(
      state({
        revision: 2,
        maxGeneration: 2,
        phase: "DRAINING_TO_FDB",
        targetBackend: "fdb",
        targetGeneration: 2,
        transitionOperationId: "transition",
      }),
    ),
    preparePinnedObject: vi.fn().mockResolvedValue(adopted),
  });

  await expect(
    reconcilePgResidueFence(store, {
      teamId: "team",
      total: 4,
      observationId: "recovery",
    }),
  ).resolves.toEqual(adopted);
  expect(store.preparePinnedObject).toHaveBeenCalledWith({
    teamId: "team",
    kind: "cross_store_intent",
    objectId: "pg-residue/team/generation/1",
    admission: {
      type: "legacy-backfill",
      backend: "pg",
      generation: 1,
    },
    requiredBackend: "pg",
    residue: { intent_unresolved: 1 },
  });
});

test("source residue fences are isolated by backend and never-reused generation", async () => {
  const adopted = pin("fdb-residue/team/generation/7", {
    kind: "cross_store_intent",
    backend: "fdb",
    generation: 7,
    admission: "legacy-backfill",
  });
  const store = storeMock({
    inspectState: vi.fn().mockResolvedValue(
      state({
        activeBackend: "fdb",
        activeGeneration: 7,
        maxGeneration: 7,
        phase: "DRAINING_TO_PG",
        targetBackend: "pg",
        targetGeneration: 8,
      }),
    ),
    inspectPin: vi.fn().mockResolvedValue(null),
    preparePinnedObject: vi.fn().mockResolvedValue(adopted),
  });

  await expect(
    reconcileFdbResidueFence(store, {
      teamId: "team",
      total: 2,
      observationId: "legacy-fdb-snapshot",
    }),
  ).resolves.toEqual(adopted);
  expect(store.preparePinnedObject).toHaveBeenCalledWith({
    teamId: "team",
    kind: "cross_store_intent",
    objectId: "fdb-residue/team/generation/7",
    admission: {
      type: "legacy-backfill",
      backend: "fdb",
      generation: 7,
    },
    requiredBackend: "fdb",
    residue: { intent_unresolved: 1 },
  });
});

test("PG publication adapter prepares and resolves every intent exact-once", async () => {
  const pins = new Map<string, MigrationObjectPin>();
  const operations = new Map<string, MigrationObjectPin>();
  const prepare = vi.fn(async input => {
    const existing = pins.get(input.objectId);
    if (existing) return existing;
    const prepared = pin(input.objectId, {
      teamId: input.teamId,
      admission:
        input.admission.type === "new-root"
          ? "new-root"
          : "pinned-continuation",
      sourceKind:
        input.admission.type === "pinned-continuation"
          ? input.admission.source.kind
          : undefined,
      sourceObjectId:
        input.admission.type === "pinned-continuation"
          ? input.admission.source.objectId
          : undefined,
    });
    pins.set(input.objectId, prepared);
    return prepared;
  });
  const store = storeMock({
    preparePinnedObject: prepare,
    preparePinnedObjects: vi.fn(async inputs =>
      Promise.all(inputs.map(prepare)),
    ),
    inspectPin: vi.fn(async (_kind, objectId) => pins.get(objectId) ?? null),
    transitionObjectResidue: vi.fn(async input => {
      const replay = operations.get(input.operationId);
      if (replay) return replay;
      const next = pin(input.objectId, {
        ...pins.get(input.objectId),
        lifecycle: input.toLifecycle,
        residue: {
          ...pin(input.objectId).residue,
          intent_unresolved: 0,
          capacity_team_pending: input.residue.capacity_team_pending ?? 0,
          capacity_ready_active: input.residue.capacity_ready_active ?? 0,
        },
      });
      operations.set(input.operationId, next);
      pins.set(input.objectId, next);
      return next;
    }),
  });
  const adapter = new DurableNuQPgPublicationAdapter(store);
  const publication = {
    id: "job",
    ownerId: "team",
    groupId: "crawl",
    placement: "backlog" as const,
  };

  await adapter.prepare([publication]);
  await adapter.prepare([publication]);
  await adapter.complete([publication], "published");
  await adapter.complete([publication], "published");
  await adapter.complete([publication], "promoted");
  await adapter.complete([publication], "promoted");
  // A later incompatible stable-ID retry compensates only a newly prepared
  // intent; it must not terminalize this prior active publication.
  await adapter.complete([publication], "compensated");

  expect(store.completePinnedObject).not.toHaveBeenCalled();
  expect(store.preparePinnedObjects).toHaveBeenNthCalledWith(1, [
    {
      teamId: "team",
      kind: "scrape_job",
      objectId: "job",
      admission: {
        type: "pinned-continuation",
        source: { kind: "group", objectId: "crawl" },
      },
      requiredBackend: "pg",
      residue: { intent_unresolved: 1 },
    },
  ]);
  expect(operations).toHaveLength(2);
  expect(pins.get("job")).toMatchObject({
    lifecycle: "active",
    residue: { intent_unresolved: 0, capacity_ready_active: 1 },
  });
});
