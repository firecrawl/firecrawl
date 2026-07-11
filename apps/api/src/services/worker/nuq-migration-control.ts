import type {
  MigrationBackend,
  MigrationObjectKind,
  MigrationObjectPin,
  MigrationResidue,
  MigrationSteadyResolution,
  MigrationTeamPinsPage,
  MigrationTeamState,
  PreparePinnedObjectInput,
  TransitionObjectResidueInput,
  CompletePinnedObjectInput,
} from "./nuq-fdb/migration-store";
import type {
  NuQPgPublication,
  NuQPgPublicationAdapter,
  NuQPgPublicationOutcome,
} from "./nuq-pg-publication";

export interface NuQMigrationStorePort {
  inspectState(teamId: string): Promise<MigrationTeamState | null>;
  resolveSteady(
    teamId: string,
    desiredBackend: MigrationBackend,
  ): Promise<MigrationSteadyResolution>;
  initializeLegacyTeam(
    teamId: string,
    backend: MigrationBackend,
    operationId: string,
    options?: { ifAbsent?: boolean },
  ): Promise<MigrationTeamState>;
  beginTransition(input: {
    teamId: string;
    targetBackend: MigrationBackend;
    operationId: string;
    expectedRevision?: number;
  }): Promise<MigrationTeamState>;
  cancelTransition(input: {
    teamId: string;
    transitionOperationId: string;
    expectedRevision?: number;
  }): Promise<MigrationTeamState>;
  finalSeal(input: {
    teamId: string;
    transitionOperationId: string;
    expectedRevision?: number;
  }): Promise<MigrationTeamState>;
  inspectTeamPinsPage(
    teamId: string,
    options: {
      limit: number;
      cursor?: { kind: MigrationObjectKind; objectId: string };
    },
  ): Promise<MigrationTeamPinsPage>;
  inspectPin(
    kind: MigrationObjectKind,
    objectId: string,
  ): Promise<MigrationObjectPin | null>;
  preparePinnedObject(
    input: PreparePinnedObjectInput,
  ): Promise<MigrationObjectPin>;
  preparePinnedObjects(
    inputs: readonly PreparePinnedObjectInput[],
  ): Promise<MigrationObjectPin[]>;
  transitionObjectResidue(
    input: TransitionObjectResidueInput,
  ): Promise<MigrationObjectPin>;
  completePinnedObject(
    input: CompletePinnedObjectInput,
  ): Promise<MigrationObjectPin>;
}

export class NuQRouterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(`${code}: ${message}`);
    this.name = this.constructor.name;
  }
}

export class NuQRouterMigrationInProgressError extends NuQRouterError {
  constructor(teamId: string, operationId: string) {
    super(
      "NUQ_MIGRATION_IN_PROGRESS",
      `team ${teamId} is changing queue backends (${operationId})`,
      true,
    );
  }
}

export class NuQRouterBackendUnavailableError extends NuQRouterError {
  constructor(kind: string, objectId: string, cause?: unknown) {
    super(
      "NUQ_ROUTER_FDB_UNAVAILABLE",
      `cannot authoritatively resolve ${kind}/${objectId}`,
      true,
    );
    if (cause !== undefined) this.cause = cause;
  }
}

export class NuQRouterBothBackendsError extends NuQRouterError {
  constructor(kind: string, objectId: string) {
    super(
      "NUQ_ROUTER_BOTH_BACKENDS_PRESENT",
      `${kind}/${objectId} exists in both pg and fdb`,
    );
  }
}

export class NuQRouterCorruptMarkerError extends NuQRouterError {
  constructor(kind: string, objectId: string) {
    super(
      "NUQ_ROUTER_CORRUPT_BACKEND_MARKER",
      `${kind}/${objectId} has a corrupt backend marker and no authoritative record`,
    );
  }
}

export class NuQRouterPinMismatchError extends NuQRouterError {
  constructor(
    kind: string,
    objectId: string,
    pinned: MigrationBackend,
    actual: MigrationBackend,
  ) {
    super(
      "NUQ_ROUTER_PIN_BACKEND_MISMATCH",
      `${kind}/${objectId} is pinned to ${pinned} but exists in ${actual}`,
    );
  }
}

export class NuQRouterLivePinMissingError extends NuQRouterError {
  constructor(kind: string, objectId: string, lifecycle: string) {
    super(
      "NUQ_ROUTER_LIVE_PIN_OBJECT_MISSING",
      `${kind}/${objectId} has a ${lifecycle} durable pin but no backend object`,
      true,
    );
  }
}

export class NuQRouterStaleMarkerError extends NuQRouterError {
  constructor(kind: string, objectId: string, marker: MigrationBackend) {
    super(
      "NUQ_ROUTER_STALE_BACKEND_MARKER",
      `${kind}/${objectId} has a stale ${marker} marker and no durable record`,
    );
  }
}

export class NuQRouterObjectNotFoundError extends NuQRouterError {
  constructor(kind: string, objectId: string) {
    super("NUQ_ROUTER_OBJECT_NOT_FOUND", `${kind}/${objectId} was not found`);
  }
}

export type BackendMarker = MigrationBackend | "corrupt" | null;

export function hasLegacyFdbTeamResidue(input: {
  scrapePending: number;
  scrapeActive: number;
  scrapeIndexedLive: boolean;
  crawlFinishedPending: number;
  crawlFinishedActive: number;
  crawlFinishedIndexedLive: boolean;
  activeGroups: number;
}): boolean {
  return Object.values(input).some(value =>
    typeof value === "boolean" ? value : value > 0,
  );
}

/**
 * Discover legacy team authority before initializing durable state. FDB must
 * be probed first: its unavailability is retryable and must never be re-read as
 * an empty result that falls through to PG.
 */
export async function discoverLegacyTeamBackend(input: {
  teamId: string;
  probeFdbResidue: () => Promise<boolean>;
  probePgResidue: () => Promise<boolean>;
  emptyBackend: MigrationBackend;
}): Promise<MigrationBackend> {
  let fdbPresent: boolean;
  try {
    fdbPresent = await input.probeFdbResidue();
  } catch (error) {
    throw new NuQRouterBackendUnavailableError("team", input.teamId, error);
  }
  const pgPresent = await input.probePgResidue();
  if (fdbPresent && pgPresent) {
    throw new NuQRouterBothBackendsError("team", input.teamId);
  }
  if (fdbPresent) return "fdb";
  if (pgPresent) return "pg";
  return input.emptyBackend;
}

export function stableLegacyInitializationOperationId(
  teamId: string,
  backend: MigrationBackend,
): string {
  return `nuq-router/v1/team/${teamId}/initialize/${backend}`;
}

export function stableTransitionOperationId(
  state: MigrationTeamState,
  targetBackend: MigrationBackend,
): string {
  return `nuq-router/v1/team/${state.teamId}/after-generation/${state.maxGeneration}/to/${targetBackend}`;
}

export async function recoverLegacyTeamState(
  store: NuQMigrationStorePort,
  teamId: string,
  discoverLegacyBackend: () => Promise<MigrationBackend>,
): Promise<MigrationTeamState> {
  const existing = await store.inspectState(teamId);
  if (existing) return existing;
  const legacyBackend = await discoverLegacyBackend();
  // A concurrent initializer wins authoritatively. `ifAbsent` returns its
  // state instead of interpreting stale discovery as a rollout request.
  return await store.initializeLegacyTeam(
    teamId,
    legacyBackend,
    stableLegacyInitializationOperationId(teamId, legacyBackend),
    { ifAbsent: true },
  );
}

/**
 * Resolve the desired flag against durable FDB state. A flag is a request, not
 * routing authority. This function starts/cancels transitions but never seals
 * one; finalSeal is reserved for a reconciler after durable residue is zero.
 */
export async function reconcileDesiredTeamBackend(
  store: NuQMigrationStorePort,
  teamId: string,
  desiredBackend: MigrationBackend,
  discoverLegacyBackend: () => Promise<MigrationBackend>,
): Promise<MigrationTeamState> {
  let resolution = await store.resolveSteady(teamId, desiredBackend);
  if (resolution.status === "legacy-uninitialized") {
    // This invocation had no durable state when it began. Return whichever
    // initialization won; do not reinterpret stale discovery/the flag as a
    // begin/cancel request against a concurrent winner.
    return await recoverLegacyTeamState(store, teamId, discoverLegacyBackend);
  }
  if (resolution.status === "steady") return resolution.state;
  if (resolution.status === "cancel-required") {
    return await store.cancelTransition({
      teamId,
      transitionOperationId: resolution.state.transitionOperationId!,
      expectedRevision: resolution.state.revision,
    });
  }
  if (resolution.status === "transition-required") {
    const operationId = stableTransitionOperationId(
      resolution.state,
      desiredBackend,
    );
    await store.beginTransition({
      teamId,
      targetBackend: desiredBackend,
      operationId,
      expectedRevision: resolution.state.revision,
    });
    throw new NuQRouterMigrationInProgressError(teamId, operationId);
  }
  throw new NuQRouterMigrationInProgressError(
    teamId,
    resolution.state.transitionOperationId!,
  );
}

export async function resolveAuthoritativeObjectBackend(input: {
  kind: MigrationObjectKind;
  objectId: string;
  marker: BackendMarker;
  readPin: () => Promise<MigrationObjectPin | null>;
  probeFdb: () => Promise<boolean>;
  probePg: () => Promise<boolean>;
  repairMarker?: (backend: MigrationBackend | null) => Promise<void> | void;
}): Promise<MigrationBackend | null> {
  const { kind, objectId } = input;
  let pin: MigrationObjectPin | null;
  let fdbPresent: boolean;
  try {
    // Both reads are FDB-authoritative. Do not probe PG if FDB is unavailable:
    // doing so would turn an outage into an unsafe PG fallback.
    [pin, fdbPresent] = await Promise.all([input.readPin(), input.probeFdb()]);
  } catch (error) {
    throw new NuQRouterBackendUnavailableError(kind, objectId, error);
  }
  const pgPresent = await input.probePg();
  if (fdbPresent && pgPresent) {
    throw new NuQRouterBothBackendsError(kind, objectId);
  }
  const actual: MigrationBackend | null = fdbPresent
    ? "fdb"
    : pgPresent
      ? "pg"
      : null;
  if (pin && actual && pin.backend !== actual) {
    throw new NuQRouterPinMismatchError(kind, objectId, pin.backend, actual);
  }
  if (actual) {
    if (input.marker !== actual) {
      try {
        await input.repairMarker?.(actual);
      } catch {
        // A Redis hint repair is never part of the authoritative decision.
      }
    }
    return actual;
  }
  if (pin) {
    if (pin.lifecycle !== "terminal") {
      throw new NuQRouterLivePinMissingError(kind, objectId, pin.lifecycle);
    }
    if (input.marker !== pin.backend) {
      try {
        await input.repairMarker?.(pin.backend);
      } catch {
        // The terminal tombstone remains authoritative without its hint.
      }
    }
    return pin.backend;
  }
  if (input.marker === "corrupt") {
    throw new NuQRouterCorruptMarkerError(kind, objectId);
  }
  if (input.marker) {
    try {
      await input.repairMarker?.(null);
    } catch {
      // Still return the deterministic stale-marker error.
    }
    throw new NuQRouterStaleMarkerError(kind, objectId, input.marker);
  }
  return null;
}

function publicationResidue(
  publication: NuQPgPublication,
  outcome: NuQPgPublicationOutcome,
): Partial<MigrationResidue> {
  return outcome === "promoted" || publication.placement === "active"
    ? { capacity_ready_active: 1 }
    : { capacity_team_pending: 1 };
}

function publicationOperationId(
  publication: NuQPgPublication,
  outcome: NuQPgPublicationOutcome,
): string {
  return `nuq-router/v1/pg-publication/${publication.id}/${outcome}`;
}

/**
 * FDB intent first, PG/Redis publication second, durable resolution last.
 * The stable per-job operation IDs make complete retries exact-once.
 */
export class DurableNuQPgPublicationAdapter implements NuQPgPublicationAdapter {
  constructor(
    private readonly store: NuQMigrationStorePort,
    private readonly validatePublicationUnderLock: (
      jobIds: readonly string[],
    ) => Promise<void> = async () => {},
  ) {}

  public async validateUnderPublicationLock(
    jobIds: readonly string[],
  ): Promise<void> {
    await this.validatePublicationUnderLock(jobIds);
  }

  public async prepare(
    publications: readonly NuQPgPublication[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const publication of publications) {
      if (seen.has(publication.id)) {
        throw new NuQRouterError(
          "NUQ_PG_PUBLICATION_DUPLICATE_ID",
          `publication batch repeats ${publication.id}`,
        );
      }
      seen.add(publication.id);
    }
    const pins = await this.store.preparePinnedObjects(
      publications.map(publication => ({
        teamId: publication.ownerId,
        kind: "scrape_job" as const,
        objectId: publication.id,
        admission: publication.groupId
          ? ({
              type: "pinned-continuation",
              source: { kind: "group", objectId: publication.groupId },
            } as const)
          : ({ type: "new-root" } as const),
        requiredBackend: "pg" as const,
        residue: { intent_unresolved: 1 },
      })),
    );
    for (let index = 0; index < publications.length; index++) {
      const publication = publications[index];
      const pin = pins[index];
      if (pin.backend !== "pg") {
        throw new NuQRouterPinMismatchError(
          "scrape_job",
          publication.id,
          pin.backend,
          "pg",
        );
      }
      if (pin.lifecycle === "terminal") {
        throw new NuQRouterError(
          "NUQ_PG_PUBLICATION_TERMINAL_PIN",
          `scrape_job/${publication.id} cannot be republished`,
        );
      }
    }
  }

  public async complete(
    publications: readonly NuQPgPublication[],
    outcome: NuQPgPublicationOutcome,
  ): Promise<void> {
    for (const publication of publications) {
      const pin = await this.store.inspectPin("scrape_job", publication.id);
      if (!pin) {
        throw new NuQRouterError(
          "NUQ_MIGRATION_PIN_NOT_FOUND",
          `scrape_job/${publication.id} has no publication pin`,
        );
      }
      if (outcome === "compensated") {
        // A stable-ID retry may discover an incompatible row after an earlier
        // publication already activated this pin. Roll back only this call's
        // still-prepared intent; never retire prior live work.
        if (pin.lifecycle === "active" || pin.lifecycle === "terminal") {
          continue;
        }
        await this.store.completePinnedObject({
          teamId: publication.ownerId,
          kind: "scrape_job",
          objectId: publication.id,
          operationId: publicationOperationId(publication, outcome),
          fromLifecycle: "prepared",
        });
        continue;
      }
      if (pin.lifecycle === "terminal") {
        throw new NuQRouterError(
          "NUQ_PG_PUBLICATION_TERMINAL_PIN",
          `scrape_job/${publication.id} cannot be republished`,
        );
      }
      if (outcome === "published" && pin.lifecycle === "active") {
        // Compatible stable-ID publication replay.
        continue;
      }
      if (outcome === "promoted" && pin.lifecycle === "prepared") {
        await this.store.transitionObjectResidue({
          teamId: publication.ownerId,
          kind: "scrape_job",
          objectId: publication.id,
          operationId: publicationOperationId(publication, "published"),
          fromLifecycle: "prepared",
          toLifecycle: "active",
          residue: publicationResidue(publication, "published"),
        });
      }
      await this.store.transitionObjectResidue({
        teamId: publication.ownerId,
        kind: "scrape_job",
        objectId: publication.id,
        operationId: publicationOperationId(publication, outcome),
        fromLifecycle: outcome === "promoted" ? "active" : "prepared",
        toLifecycle: "active",
        residue: publicationResidue(publication, outcome),
      });
    }
  }

  public async retire(
    kind: "scrape_job" | "crawl_finished",
    objectId: string,
  ): Promise<void> {
    const pin = await this.store.inspectPin(kind, objectId);
    if (!pin || pin.lifecycle === "terminal") return;
    await this.store.completePinnedObject({
      teamId: pin.teamId,
      kind,
      objectId,
      operationId: `nuq-router/v1/pg-terminal/${kind}/${objectId}`,
      fromLifecycle: pin.lifecycle,
    });
  }
}

export function sourceResidueFenceObjectId(
  teamId: string,
  backend: MigrationBackend,
  generation: number,
): string {
  return `${backend}-residue/${teamId}/generation/${generation}`;
}

/**
 * Persist one unresolved fence while residue observed outside the generation
 * counters is non-zero. A separate fence is burned for every never-reused
 * source generation, so a later PG -> FDB -> PG cycle cannot reopen a closed
 * generation's pin. observationId must identify the exact observation retry.
 * This bounded token reconciles commit-unknown only while it is the pin's
 * current last operation. A caller retrying the outer reconciliation after an
 * error must re-read the source; a superseded stale observation has no source
 * epoch and is intentionally not replayable.
 */
export async function reconcileSourceResidueFence(
  store: NuQMigrationStorePort,
  input: {
    teamId: string;
    backend: MigrationBackend;
    total: number;
    observationId: string;
  },
): Promise<MigrationObjectPin> {
  if (!Number.isSafeInteger(input.total) || input.total < 0) {
    throw new NuQRouterError(
      "NUQ_MIGRATION_INVALID_SOURCE_RESIDUE",
      "source residue total must be a nonnegative safe integer",
    );
  }
  const state = await store.inspectState(input.teamId);
  if (!state || state.activeBackend !== input.backend) {
    throw new NuQRouterError(
      "NUQ_MIGRATION_SOURCE_NOT_ACTIVE",
      `team ${input.teamId} has no active ${input.backend} generation for residue adoption`,
    );
  }
  const objectId = sourceResidueFenceObjectId(
    input.teamId,
    input.backend,
    state.activeGeneration,
  );
  let pin = await store.inspectPin("cross_store_intent", objectId);
  if (!pin) {
    pin = await store.preparePinnedObject({
      teamId: input.teamId,
      kind: "cross_store_intent",
      objectId,
      admission: {
        type: "legacy-backfill",
        backend: input.backend,
        generation: state.activeGeneration,
      },
      requiredBackend: input.backend,
      residue: { intent_unresolved: input.total === 0 ? 0 : 1 },
    });
    return pin;
  }
  if (
    pin.backend !== input.backend ||
    pin.generation !== state.activeGeneration ||
    pin.lifecycle === "terminal"
  ) {
    throw new NuQRouterPinMismatchError(
      "cross_store_intent",
      objectId,
      pin.backend,
      input.backend,
    );
  }
  const intentUnresolved = input.total === 0 ? 0 : 1;
  const operationPrefix = `nuq-router/v1/${input.backend}-residue/${input.observationId}/pin-revision/`;
  const replay =
    pin.lastOperation?.operationId.startsWith(operationPrefix) === true &&
    pin.lastOperation.fromLifecycle === pin.lifecycle &&
    pin.lastOperation.toLifecycle === pin.lifecycle &&
    pin.lastOperation.residue.intent_unresolved === intentUnresolved &&
    Object.entries(pin.lastOperation.residue).every(
      ([counter, value]) => counter === "intent_unresolved" || value === 0,
    )
      ? pin.lastOperation
      : undefined;
  return await store.transitionObjectResidue({
    teamId: input.teamId,
    kind: "cross_store_intent",
    objectId,
    operationId: replay?.operationId ?? `${operationPrefix}${pin.revision}`,
    fromLifecycle: pin.lifecycle,
    toLifecycle: pin.lifecycle,
    residue: { intent_unresolved: intentUnresolved },
    expectedRevision: replay ? replay.resultRevision - 1 : pin.revision,
  });
}

export async function reconcilePgResidueFence(
  store: NuQMigrationStorePort,
  input: { teamId: string; total: number; observationId: string },
): Promise<MigrationObjectPin> {
  return await reconcileSourceResidueFence(store, {
    ...input,
    backend: "pg",
  });
}

export async function reconcileFdbResidueFence(
  store: NuQMigrationStorePort,
  input: { teamId: string; total: number; observationId: string },
): Promise<MigrationObjectPin> {
  return await reconcileSourceResidueFence(store, {
    ...input,
    backend: "fdb",
  });
}
