import { randomUUID } from "crypto";
import type {
  Transaction,
  TransactionOptionCode as FdbTransactionOptionCode,
} from "foundationdb";
import { getFdb, getNuqFdbDatabase } from "./client";
import { encodeI64 } from "./keyspace";

export type MigrationBackend = "pg" | "fdb";
export type MigrationPhase =
  | "PG_ONLY"
  | "DRAINING_TO_FDB"
  | "FDB_ONLY"
  | "DRAINING_TO_PG"
  | "ERROR";
export type MigrationGenerationStatus = "open" | "draining" | "closed";
export type MigrationObjectKind =
  | "scrape_job"
  | "group"
  | "external_holder"
  | "crawl_finished"
  | "sweeper_task"
  | "cross_store_intent";
export type MigrationObjectLifecycle = "prepared" | "active" | "terminal";

export const MIGRATION_RESIDUE_COUNTERS = [
  "capacity_team_pending",
  "capacity_key_pending",
  "capacity_crawl_pending",
  "capacity_delayed",
  "capacity_ready_active",
  "capacity_external_holders",
  "control_groups",
  "control_crawl_finished",
  "control_sweeper_tasks",
  "intent_unresolved",
] as const;

export type MigrationResidueCounter =
  (typeof MIGRATION_RESIDUE_COUNTERS)[number];
export type MigrationResidue = Record<MigrationResidueCounter, number>;

export type MigrationGeneration = {
  schemaVersion: 1;
  teamId: string;
  backend: MigrationBackend;
  generation: number;
  status: MigrationGenerationStatus;
  /** Present on generations created by the bounded-GC protocol. Older
   * generations deliberately remain ineligible until explicitly backfilled. */
  gcIndexed?: true;
  terminalAt?: number;
  terminalVersion?: number;
};

export type MigrationTeamState = {
  schemaVersion: 1;
  teamId: string;
  revision: number;
  maxGeneration: number;
  activeBackend: MigrationBackend;
  activeGeneration: number;
  phase: MigrationPhase;
  targetBackend?: MigrationBackend;
  targetGeneration?: number;
  transitionOperationId?: string;
};

export type MigrationObjectLastOperation = {
  schemaVersion: 1;
  operationId: string;
  fromLifecycle: MigrationObjectLifecycle;
  toLifecycle: MigrationObjectLifecycle;
  residue: MigrationResidue;
  resultRevision: number;
};

export type MigrationObjectPin = {
  schemaVersion: 1;
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  backend: MigrationBackend;
  generation: number;
  lifecycle: MigrationObjectLifecycle;
  revision: number;
  admission: "new-root" | "pinned-continuation" | "legacy-backfill";
  sourceKind?: MigrationObjectKind;
  sourceObjectId?: string;
  initialResidue: MigrationResidue;
  residue: MigrationResidue;
  /** Single bounded commit-unknown reconciliation token. A later mutation
   * supersedes it; no per-transition ledger rows are accumulated. */
  lastOperation?: MigrationObjectLastOperation;
  /** Immutable identity of the terminal incarnation. It fences delayed GC
   * entries from a newer/replaced record with the same object id. */
  terminalAt?: number;
  terminalVersion?: number;
};

export const MIGRATION_GC_PARTITIONS = 32;
export const MIGRATION_GC_PAGE_LIMIT = 100;
// Longer than the 30-day Redis routing hint TTL, so a tombstone can never be
// collected while a surviving hint is still expected to route callers.
export const MIGRATION_GC_MIN_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
export const MIGRATION_GC_RECHECK_MS = 60 * 60 * 1000;
const MIGRATION_GC_LEASE_MS = 30_000;
const MIGRATION_GC_TRANSACTION_TIMEOUT_MS = 10_000;
const TransactionOptionCode = {
  Timeout: 500 as FdbTransactionOptionCode,
};

async function withGcDeadline<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error("GC aborted");
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("GC authority operation timed out")),
      MIGRATION_GC_TRANSACTION_TIMEOUT_MS,
    );
    if (signal) {
      abort = () => reject(signal.reason ?? new Error("GC aborted"));
      signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abort) signal.removeEventListener("abort", abort);
  }
}

export type MigrationGcAuthority = {
  /** Must use only bounded point reads. This is run before the FDB CAS for PG
   * objects, and must return true whenever the canonical PG object may live. */
  pgObjectExists(
    pin: MigrationObjectPin,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Conflict-safe FDB point reads for runtime rows, task rows, durable PG
   * holder intents and deletion intents. */
  fdbReferenceExistsInTxn(
    tn: Transaction,
    pin: MigrationObjectPin,
  ): Promise<boolean>;
};

export type MigrationGcCategory = "pin" | "control" | "generation";

export type MigrationGcBacklog = {
  due: number;
  oldestDueAt: number | null;
  oldestOverdueMs: number;
};

export type MigrationGcSweepResult = {
  partition: number;
  read: number;
  removed: number;
  retained: number;
  stale: number;
  hasMore: boolean;
};

export type MigrationPinAdmission =
  | { type: "new-root" }
  | {
      type: "pinned-continuation";
      source: { kind: MigrationObjectKind; objectId: string };
    }
  | {
      // Explicit interpretation for an object known to predate control-plane
      // initialization. Never infer this from Redis or today's rollout flag.
      type: "legacy-backfill";
      backend: MigrationBackend;
      generation: number;
      terminal?: boolean;
    };

export type PreparePinnedObjectInput = {
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  admission: MigrationPinAdmission;
  requiredBackend?: MigrationBackend;
  residue?: Partial<MigrationResidue>;
};

export type TransitionObjectResidueInput = {
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  operationId: string;
  fromLifecycle: MigrationObjectLifecycle;
  toLifecycle: MigrationObjectLifecycle;
  residue: Partial<MigrationResidue>;
  /** Compared with the pin revision before mutation. Exact replay of the
   * current lastOperation wins before this check for commit-unknown recovery. */
  expectedRevision?: number;
};

export type MigrationTeamPinsPage = {
  pins: MigrationObjectPin[];
  nextCursor?: { kind: MigrationObjectKind; objectId: string };
};

export type CompletePinnedObjectInput = {
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  operationId: string;
  fromLifecycle: "prepared" | "active";
};

export type MigrationRecordPin = {
  backend: MigrationBackend;
  generation: number;
};

export type ReconcileManagedObjectInput = {
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  /** Pin copied onto the runtime record. It may be omitted only while creating
   * that record; existing managed records must always carry it. */
  recordPin?: MigrationRecordPin;
  allowMissingRecordPin?: boolean;
  residue: Partial<MigrationResidue>;
  terminal?: boolean;
  /** Legacy cancelled groups must adopt their sweeper continuation in the
   * same transaction before the group itself becomes terminal. */
  cancelledGroupContinuation?: boolean;
  /** Validation-only callers suppress the prepared->active transition. */
  activateNonterminal?: boolean;
};

export type MigrationSteadyResolution =
  | { status: "legacy-uninitialized" }
  | { status: "steady"; state: MigrationTeamState }
  | { status: "transition-required"; state: MigrationTeamState }
  | { status: "transitioning"; state: MigrationTeamState }
  | { status: "cancel-required"; state: MigrationTeamState };

export class MigrationStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(`${code}: ${message}`);
    this.name = this.constructor.name;
  }
}

export class MigrationCorruptionError extends MigrationStoreError {
  constructor(record: string, detail: string) {
    super("NUQ_MIGRATION_CORRUPT", `${record}: ${detail}`);
  }
}

export class MigrationCasError extends MigrationStoreError {
  constructor(expected: number, actual: number) {
    super(
      "NUQ_MIGRATION_CAS_MISMATCH",
      `expected revision ${expected}, found ${actual}`,
      true,
    );
  }
}

export class MigrationInProgressError extends MigrationStoreError {
  constructor(teamId: string) {
    super(
      "NUQ_MIGRATION_IN_PROGRESS",
      `new root admission is closed for team ${teamId}`,
      true,
    );
  }
}

export class MigrationStaleGenerationError extends MigrationStoreError {
  constructor(teamId: string, backend: MigrationBackend, generation: number) {
    super(
      "NUQ_MIGRATION_STALE_GENERATION",
      `generation ${backend}/${generation} is not open or draining for team ${teamId}`,
      true,
    );
  }
}

export class MigrationResidueNotEmptyError extends MigrationStoreError {
  constructor(teamId: string, generation: number, residue: MigrationResidue) {
    const nonzero = Object.entries(residue)
      .filter(([, value]) => value !== 0)
      .map(([name, value]) => `${name}=${value}`)
      .join(",");
    super(
      "NUQ_MIGRATION_RESIDUE_NOT_EMPTY",
      `team ${teamId} generation ${generation} has residue ${nonzero}`,
      true,
    );
  }
}

export class MigrationLegacyStateError extends MigrationStoreError {
  constructor(teamId: string) {
    super(
      "NUQ_MIGRATION_LEGACY_UNINITIALIZED",
      `team ${teamId} must be explicitly initialized with its legacy backend`,
    );
  }
}

export class MigrationOperationConflictError extends MigrationStoreError {
  constructor(operationId: string) {
    super(
      "NUQ_MIGRATION_OPERATION_CONFLICT",
      `operation ${operationId} was already used with different input`,
    );
  }
}

const BACKENDS: readonly MigrationBackend[] = ["pg", "fdb"];
const PHASES: readonly MigrationPhase[] = [
  "PG_ONLY",
  "DRAINING_TO_FDB",
  "FDB_ONLY",
  "DRAINING_TO_PG",
  "ERROR",
];
const GENERATION_STATUSES: readonly MigrationGenerationStatus[] = [
  "open",
  "draining",
  "closed",
];
const OBJECT_KINDS: readonly MigrationObjectKind[] = [
  "scrape_job",
  "group",
  "external_holder",
  "crawl_finished",
  "sweeper_task",
  "cross_store_intent",
];
const OBJECT_LIFECYCLES: readonly MigrationObjectLifecycle[] = [
  "prepared",
  "active",
  "terminal",
];

function assertNonempty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new MigrationStoreError(
      "NUQ_MIGRATION_INVALID_ARGUMENT",
      `${name} must be non-empty`,
    );
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function migrationGcPartition(identity: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % MIGRATION_GC_PARTITIONS;
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function parseJson(value: Buffer | undefined | null, record: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value.toString("utf8"));
  } catch {
    throw new MigrationCorruptionError(record, "invalid JSON");
  }
}

function normalizeResidue(
  input: Partial<MigrationResidue> | undefined,
  record = "residue input",
): MigrationResidue {
  const source = input ?? {};
  for (const key of Object.keys(source)) {
    if (!(MIGRATION_RESIDUE_COUNTERS as readonly string[]).includes(key)) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        `${record} contains unknown counter ${key}`,
      );
    }
  }
  return Object.fromEntries(
    MIGRATION_RESIDUE_COUNTERS.map(counter => {
      const value = source[counter] ?? 0;
      if (!isNonnegativeInteger(value)) {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_INVALID_ARGUMENT",
          `${record}.${counter} must be a nonnegative safe integer`,
        );
      }
      return [counter, value];
    }),
  ) as MigrationResidue;
}

function validateStoredResidue(
  value: unknown,
  record: string,
): MigrationResidue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid residue");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== MIGRATION_RESIDUE_COUNTERS.length ||
    keys.some(
      key => !(MIGRATION_RESIDUE_COUNTERS as readonly string[]).includes(key),
    )
  ) {
    throw new MigrationCorruptionError(record, "invalid residue counters");
  }
  const residue = value as Record<string, unknown>;
  for (const counter of MIGRATION_RESIDUE_COUNTERS) {
    if (!isNonnegativeInteger(residue[counter])) {
      throw new MigrationCorruptionError(record, `invalid counter ${counter}`);
    }
  }
  return residue as MigrationResidue;
}

function validateTeamState(value: unknown, record: string): MigrationTeamState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid team state");
  }
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== 1 ||
    typeof state.teamId !== "string" ||
    !isPositiveInteger(state.revision) ||
    !isPositiveInteger(state.maxGeneration) ||
    !BACKENDS.includes(state.activeBackend as MigrationBackend) ||
    !isPositiveInteger(state.activeGeneration) ||
    state.activeGeneration > state.maxGeneration ||
    !PHASES.includes(state.phase as MigrationPhase)
  ) {
    throw new MigrationCorruptionError(record, "invalid team state fields");
  }
  const transitioning =
    state.phase === "DRAINING_TO_FDB" || state.phase === "DRAINING_TO_PG";
  if (transitioning) {
    if (
      !BACKENDS.includes(state.targetBackend as MigrationBackend) ||
      !isPositiveInteger(state.targetGeneration) ||
      typeof state.transitionOperationId !== "string" ||
      state.transitionOperationId.length === 0 ||
      state.targetBackend === state.activeBackend ||
      state.targetGeneration !== state.maxGeneration ||
      state.targetGeneration <= state.activeGeneration
    ) {
      throw new MigrationCorruptionError(record, "invalid transition fields");
    }
  } else if (
    state.targetBackend !== undefined ||
    state.targetGeneration !== undefined ||
    state.transitionOperationId !== undefined
  ) {
    throw new MigrationCorruptionError(record, "unexpected transition fields");
  }
  if (
    (state.phase === "PG_ONLY" && state.activeBackend !== "pg") ||
    (state.phase === "FDB_ONLY" && state.activeBackend !== "fdb") ||
    (state.phase === "DRAINING_TO_FDB" && state.targetBackend !== "fdb") ||
    (state.phase === "DRAINING_TO_PG" && state.targetBackend !== "pg")
  ) {
    throw new MigrationCorruptionError(record, "phase/backend mismatch");
  }
  return state as MigrationTeamState;
}

function validateGeneration(
  value: unknown,
  record: string,
): MigrationGeneration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid generation");
  }
  const generation = value as Record<string, unknown>;
  if (
    generation.schemaVersion !== 1 ||
    typeof generation.teamId !== "string" ||
    !BACKENDS.includes(generation.backend as MigrationBackend) ||
    !isPositiveInteger(generation.generation) ||
    !GENERATION_STATUSES.includes(
      generation.status as MigrationGenerationStatus,
    ) ||
    (generation.gcIndexed !== undefined && generation.gcIndexed !== true) ||
    (generation.terminalAt !== undefined &&
      !isNonnegativeInteger(generation.terminalAt)) ||
    (generation.terminalVersion !== undefined &&
      !isPositiveInteger(generation.terminalVersion)) ||
    (generation.terminalAt === undefined) !==
      (generation.terminalVersion === undefined) ||
    (generation.status !== "closed" && generation.terminalAt !== undefined)
  ) {
    throw new MigrationCorruptionError(record, "invalid generation fields");
  }
  return generation as MigrationGeneration;
}

function validatePin(value: unknown, record: string): MigrationObjectPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid object pin");
  }
  const pin = value as Record<string, unknown>;
  if (
    pin.schemaVersion !== 1 ||
    typeof pin.teamId !== "string" ||
    !OBJECT_KINDS.includes(pin.kind as MigrationObjectKind) ||
    typeof pin.objectId !== "string" ||
    !BACKENDS.includes(pin.backend as MigrationBackend) ||
    !isPositiveInteger(pin.generation) ||
    !OBJECT_LIFECYCLES.includes(pin.lifecycle as MigrationObjectLifecycle) ||
    !isPositiveInteger(pin.revision) ||
    (pin.admission !== "new-root" &&
      pin.admission !== "pinned-continuation" &&
      pin.admission !== "legacy-backfill")
  ) {
    throw new MigrationCorruptionError(record, "invalid object pin fields");
  }
  if (
    ((pin.admission === "new-root" || pin.admission === "legacy-backfill") &&
      (pin.sourceKind !== undefined || pin.sourceObjectId !== undefined)) ||
    (pin.admission === "pinned-continuation" &&
      (!OBJECT_KINDS.includes(pin.sourceKind as MigrationObjectKind) ||
        typeof pin.sourceObjectId !== "string" ||
        pin.sourceObjectId.length === 0))
  ) {
    throw new MigrationCorruptionError(record, "invalid source pin fields");
  }
  if (
    (pin.terminalAt !== undefined && !isNonnegativeInteger(pin.terminalAt)) ||
    (pin.terminalVersion !== undefined &&
      !isPositiveInteger(pin.terminalVersion)) ||
    (pin.terminalAt === undefined) !== (pin.terminalVersion === undefined) ||
    (pin.lifecycle !== "terminal" && pin.terminalAt !== undefined) ||
    (pin.terminalVersion !== undefined && pin.terminalVersion !== pin.revision)
  ) {
    throw new MigrationCorruptionError(record, "invalid terminal GC fields");
  }
  const initialResidue = validateStoredResidue(
    pin.initialResidue,
    `${record}.initialResidue`,
  );
  const residue = validateStoredResidue(pin.residue, `${record}.residue`);
  let lastOperation: MigrationObjectLastOperation | undefined;
  if (pin.lastOperation !== undefined) {
    if (
      !pin.lastOperation ||
      typeof pin.lastOperation !== "object" ||
      Array.isArray(pin.lastOperation)
    ) {
      throw new MigrationCorruptionError(record, "invalid last operation");
    }
    const operation = pin.lastOperation as Record<string, unknown>;
    if (
      operation.schemaVersion !== 1 ||
      typeof operation.operationId !== "string" ||
      operation.operationId.length === 0 ||
      !OBJECT_LIFECYCLES.includes(
        operation.fromLifecycle as MigrationObjectLifecycle,
      ) ||
      !OBJECT_LIFECYCLES.includes(
        operation.toLifecycle as MigrationObjectLifecycle,
      ) ||
      !isPositiveInteger(operation.resultRevision)
    ) {
      throw new MigrationCorruptionError(
        record,
        "invalid last operation fields",
      );
    }
    const operationResidue = validateStoredResidue(
      operation.residue,
      `${record}.lastOperation.residue`,
    );
    if (
      operation.resultRevision > (pin.revision as number) ||
      (operation.resultRevision === pin.revision &&
        (operation.toLifecycle !== pin.lifecycle ||
          !residueEqual(operationResidue, residue)))
    ) {
      throw new MigrationCorruptionError(
        record,
        "last operation does not describe this pin revision history",
      );
    }
    lastOperation = {
      ...(operation as MigrationObjectLastOperation),
      residue: operationResidue,
    };
  }
  return {
    ...(pin as MigrationObjectPin),
    initialResidue,
    residue,
    ...(lastOperation ? { lastOperation } : {}),
  };
}

function decodeCounter(
  value: Buffer | undefined | null,
  record: string,
): number {
  if (!value) return 0;
  if (value.length !== 8) {
    throw new MigrationCorruptionError(record, "counter must be 8 bytes");
  }
  const decoded = Number(value.readBigInt64LE());
  if (!isNonnegativeInteger(decoded)) {
    throw new MigrationCorruptionError(
      record,
      "counter must be a nonnegative safe integer",
    );
  }
  return decoded;
}

function stablePhase(backend: MigrationBackend): MigrationPhase {
  return backend === "pg" ? "PG_ONLY" : "FDB_ONLY";
}

function drainingPhase(target: MigrationBackend): MigrationPhase {
  return target === "pg" ? "DRAINING_TO_PG" : "DRAINING_TO_FDB";
}

function nextRevision(state: MigrationTeamState): number {
  const revision = state.revision + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new MigrationCorruptionError(
      `team ${state.teamId}`,
      "revision exhausted safe integer range",
    );
  }
  return revision;
}

function residueEqual(a: MigrationResidue, b: MigrationResidue): boolean {
  return MIGRATION_RESIDUE_COUNTERS.every(counter => a[counter] === b[counter]);
}

type ControlOperation = {
  schemaVersion: 1;
  kind: "initialize" | "begin";
  operationId: string;
  backend: MigrationBackend;
  outcome: "completed" | "pending" | "cancelled";
  state: MigrationTeamState;
  terminalAt?: number;
  terminalVersion?: number;
};

// Read-only compatibility with operation rows produced by the prototype before
// pins carried their one bounded reconciliation token. New code never creates
// these rows and migrates one into the pin when it is replayed safely.
type LegacyObjectOperation = {
  schemaVersion: 1;
  operationId: string;
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  fromLifecycle: MigrationObjectLifecycle;
  toLifecycle: MigrationObjectLifecycle;
  residue: MigrationResidue;
  result: MigrationObjectPin;
};

function validateControlOperation(
  value: unknown,
  record: string,
): ControlOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid control operation");
  }
  const op = value as Record<string, unknown>;
  if (
    op.schemaVersion !== 1 ||
    (op.kind !== "initialize" && op.kind !== "begin") ||
    typeof op.operationId !== "string" ||
    !BACKENDS.includes(op.backend as MigrationBackend) ||
    (op.outcome !== "completed" &&
      op.outcome !== "pending" &&
      op.outcome !== "cancelled") ||
    (op.terminalAt !== undefined && !isNonnegativeInteger(op.terminalAt)) ||
    (op.terminalVersion !== undefined &&
      !isPositiveInteger(op.terminalVersion)) ||
    (op.terminalAt === undefined) !== (op.terminalVersion === undefined) ||
    (op.outcome === "pending" && op.terminalAt !== undefined)
  ) {
    throw new MigrationCorruptionError(
      record,
      "invalid control operation fields",
    );
  }
  const decoded = {
    ...(op as ControlOperation),
    state: validateTeamState(op.state, `${record}.state`),
  };
  const steady =
    decoded.state.phase === "PG_ONLY" || decoded.state.phase === "FDB_ONLY";
  if (
    (decoded.kind === "initialize" &&
      (decoded.outcome !== "completed" ||
        !steady ||
        decoded.state.activeBackend !== decoded.backend)) ||
    (decoded.kind === "begin" &&
      decoded.outcome === "pending" &&
      (decoded.state.transitionOperationId !== decoded.operationId ||
        decoded.state.targetBackend !== decoded.backend)) ||
    (decoded.kind === "begin" &&
      decoded.outcome === "completed" &&
      (!steady || decoded.state.activeBackend !== decoded.backend)) ||
    (decoded.kind === "begin" &&
      decoded.outcome === "cancelled" &&
      (!steady || decoded.state.activeBackend === decoded.backend))
  ) {
    throw new MigrationCorruptionError(record, "operation/state mismatch");
  }
  return decoded;
}

function validateLegacyObjectOperation(
  value: unknown,
  record: string,
): LegacyObjectOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid object operation");
  }
  const op = value as Record<string, unknown>;
  if (
    op.schemaVersion !== 1 ||
    typeof op.operationId !== "string" ||
    typeof op.teamId !== "string" ||
    !OBJECT_KINDS.includes(op.kind as MigrationObjectKind) ||
    typeof op.objectId !== "string" ||
    !OBJECT_LIFECYCLES.includes(op.fromLifecycle as MigrationObjectLifecycle) ||
    !OBJECT_LIFECYCLES.includes(op.toLifecycle as MigrationObjectLifecycle)
  ) {
    throw new MigrationCorruptionError(
      record,
      "invalid object operation fields",
    );
  }
  const decoded = {
    ...(op as LegacyObjectOperation),
    residue: validateStoredResidue(op.residue, `${record}.residue`),
    result: validatePin(op.result, `${record}.result`),
  };
  if (
    decoded.result.teamId !== decoded.teamId ||
    decoded.result.kind !== decoded.kind ||
    decoded.result.objectId !== decoded.objectId ||
    decoded.result.lifecycle !== decoded.toLifecycle ||
    !residueEqual(decoded.result.residue, decoded.residue)
  ) {
    throw new MigrationCorruptionError(record, "operation/result mismatch");
  }
  return decoded;
}

export class NuqFdbMigrationStore {
  constructor(private readonly requireCoreReadiness = false) {}

  private get db() {
    return getNuqFdbDatabase();
  }

  // This prefix is deliberately global and disjoint from every queue's
  // ("nuq", queueName) subspace.
  public pack(parts: any[]): Buffer {
    return getFdb().tuple.pack(["nuq-migration", 1, ...parts]) as Buffer;
  }

  public coreReadinessKey(queueName: "scrape" | "crawl_finished"): Buffer {
    return this.pack(["core-readiness", queueName]);
  }

  private async assertCoreReadinessInTxn(tn: Transaction): Promise<void> {
    if (!this.requireCoreReadiness) return;
    for (const queueName of ["scrape", "crawl_finished"] as const) {
      const raw = await tn.get(this.coreReadinessKey(queueName));
      const readiness = raw
        ? (parseJson(raw, `${queueName} core readiness`) as {
            phase?: unknown;
          })
        : null;
      if (readiness?.phase !== "ready") {
        throw new MigrationStoreError(
          "NUQ_FDB_CORE_METRICS_NOT_READY",
          `${queueName} corrected-core generation is not ready`,
          true,
        );
      }
    }
  }

  public teamStateKey(teamId: string): Buffer {
    return this.pack(["team", teamId, "state"]);
  }

  public generationKey(teamId: string, generation: number): Buffer {
    return this.pack(["team", teamId, "generation", generation]);
  }

  public residueKey(
    teamId: string,
    generation: number,
    counter: MigrationResidueCounter,
  ): Buffer {
    return this.pack(["team", teamId, "residue", generation, counter]);
  }

  public objectKey(kind: MigrationObjectKind, objectId: string): Buffer {
    return this.pack(["object", kind, objectId]);
  }

  private teamObjectKey(
    teamId: string,
    kind: MigrationObjectKind,
    objectId: string,
  ): Buffer {
    return this.pack(["team", teamId, "object", kind, objectId]);
  }

  private generationObjectKey(pin: MigrationObjectPin): Buffer {
    return this.pack([
      "team",
      pin.teamId,
      "generation-object",
      pin.generation,
      pin.kind,
      pin.objectId,
    ]);
  }

  private generationObjectRange(teamId: string, generation: number) {
    return getFdb().tuple.range([
      "nuq-migration",
      1,
      "team",
      teamId,
      "generation-object",
      generation,
    ]);
  }

  private terminalPinGcKey(
    pin: MigrationObjectPin,
    dueAt: number = pin.terminalAt! + MIGRATION_GC_MIN_RETENTION_MS,
  ): Buffer {
    return this.pack([
      "gc",
      "pin",
      migrationGcPartition(`${pin.kind}/${pin.objectId}`),
      dueAt,
      pin.kind,
      pin.objectId,
      pin.generation,
      pin.terminalVersion!,
      pin.terminalAt!,
    ]);
  }

  private terminalPinGcRange(partition: number, through: number) {
    return {
      begin: this.pack(["gc", "pin", partition]),
      end: this.pack(["gc", "pin", partition, through]),
    };
  }

  private gcCursorKey(category: string): Buffer {
    return this.pack(["gc", "cursor", category]);
  }

  private gcLeaseKey(category: string, partition: number): Buffer {
    return this.pack(["gc", "lease", category, partition]);
  }

  // A Fenwick tree over the safe-integer timestamp domain makes exact due
  // counts a bounded set of point reads. Each GC index mutation updates at
  // most 53 partition-local counters in the same transaction; collection never
  // scans a global index or an unbounded due range.
  private gcDueCountKey(
    category: MigrationGcCategory,
    partition: number,
    node: bigint,
  ): Buffer {
    return this.pack(["gc", "due-count", category, partition, node.toString()]);
  }

  private mutateGcDueCountInTxn(
    tn: Transaction,
    category: MigrationGcCategory,
    partition: number,
    dueAt: number,
    delta: 1 | -1,
  ): void {
    if (!isNonnegativeInteger(dueAt)) {
      throw new MigrationCorruptionError(
        `GC ${category} index`,
        "invalid due timestamp",
      );
    }
    const upper = 1n << 53n;
    let node = BigInt(dueAt) + 1n;
    while (node <= upper) {
      tn.add(this.gcDueCountKey(category, partition, node), encodeI64(delta));
      node += node & -node;
    }
  }

  private async setGcIndexInTxn(
    tn: Transaction,
    category: MigrationGcCategory,
    partition: number,
    dueAt: number,
    key: Buffer,
  ): Promise<boolean> {
    // This must be a normal read. Besides making the counter conditional, its
    // conflict range makes a commit-unknown closure replay and overlapping GC
    // workers converge on exactly one increment.
    if ((await tn.get(key)) !== undefined) return false;
    tn.set(key, Buffer.alloc(0));
    this.mutateGcDueCountInTxn(tn, category, partition, dueAt, 1);
    return true;
  }

  private async clearGcIndexInTxn(
    tn: Transaction,
    category: MigrationGcCategory,
    partition: number,
    dueAt: number,
    key: Buffer,
  ): Promise<boolean> {
    // Never decrement from a scan result alone: it may have been consumed by a
    // committed transaction whose result was lost, or by an expired owner.
    if ((await tn.get(key)) === undefined) return false;
    tn.clear(key);
    this.mutateGcDueCountInTxn(tn, category, partition, dueAt, -1);
    return true;
  }

  private controlOperationKey(teamId: string, operationId: string): Buffer {
    return this.pack(["team", teamId, "control-operation", operationId]);
  }

  private controlGenerationRefKey(
    teamId: string,
    generation: number,
    operationId: string,
  ): Buffer {
    return this.pack([
      "team",
      teamId,
      "generation-control",
      generation,
      operationId,
    ]);
  }

  private controlGenerationRefRange(teamId: string, generation: number) {
    return getFdb().tuple.range([
      "nuq-migration",
      1,
      "team",
      teamId,
      "generation-control",
      generation,
    ]);
  }

  private controlGcKey(
    teamId: string,
    operation: ControlOperation,
    dueAt = operation.terminalAt! + MIGRATION_GC_MIN_RETENTION_MS,
  ): Buffer {
    return this.pack([
      "gc",
      "control",
      migrationGcPartition(`${teamId}/${operation.operationId}`),
      dueAt,
      teamId,
      operation.operationId,
      operation.terminalVersion!,
      operation.terminalAt!,
    ]);
  }

  private generationGcKey(
    generation: MigrationGeneration,
    dueAt = generation.terminalAt! + MIGRATION_GC_MIN_RETENTION_MS,
  ): Buffer {
    return this.pack([
      "gc",
      "generation",
      migrationGcPartition(`${generation.teamId}/${generation.generation}`),
      dueAt,
      generation.teamId,
      generation.generation,
      generation.terminalVersion!,
      generation.terminalAt!,
    ]);
  }

  private gcRange(
    category: "control" | "generation",
    partition: number,
    through: number,
  ) {
    return {
      begin: this.pack(["gc", category, partition]),
      end: this.pack(["gc", category, partition, through]),
    };
  }

  private legacyObjectOperationKey(
    teamId: string,
    kind: MigrationObjectKind,
    objectId: string,
    operationId: string,
  ): Buffer {
    return this.pack([
      "team",
      teamId,
      "object-operation",
      kind,
      objectId,
      operationId,
    ]);
  }

  private legacyObjectOperationRange(
    teamId: string,
    kind: MigrationObjectKind,
    objectId: string,
  ) {
    return getFdb().tuple.range([
      "nuq-migration",
      1,
      "team",
      teamId,
      "object-operation",
      kind,
      objectId,
    ]);
  }

  private async writeGenerationInTxn(
    tn: Transaction,
    previous: MigrationGeneration | null,
    generation: MigrationGeneration,
  ): Promise<void> {
    tn.set(
      this.generationKey(generation.teamId, generation.generation),
      encodeJson(generation),
    );
    const previousIndexed =
      previous?.status === "closed" && previous.terminalAt !== undefined;
    const nextIndexed =
      generation.status === "closed" && generation.terminalAt !== undefined;
    const sameIndex =
      previousIndexed &&
      nextIndexed &&
      previous.terminalAt === generation.terminalAt &&
      previous.terminalVersion === generation.terminalVersion;
    const partition = migrationGcPartition(
      `${generation.teamId}/${generation.generation}`,
    );
    if (previousIndexed && !sameIndex) {
      const dueAt = previous.terminalAt! + MIGRATION_GC_MIN_RETENTION_MS;
      await this.clearGcIndexInTxn(
        tn,
        "generation",
        partition,
        dueAt,
        this.generationGcKey(previous),
      );
    }
    if (nextIndexed && !sameIndex) {
      const dueAt = generation.terminalAt! + MIGRATION_GC_MIN_RETENTION_MS;
      await this.setGcIndexInTxn(
        tn,
        "generation",
        partition,
        dueAt,
        this.generationGcKey(generation),
      );
    }
  }

  private controlReferencedGenerations(operation: ControlOperation): number[] {
    return [
      operation.state.activeGeneration,
      ...(operation.state.targetGeneration === undefined
        ? []
        : [operation.state.targetGeneration]),
    ];
  }

  private async writeControlOperationInTxn(
    tn: Transaction,
    teamId: string,
    previous: ControlOperation | null,
    operation: ControlOperation,
  ): Promise<void> {
    const previousIndexed = previous?.terminalAt !== undefined;
    const nextIndexed = operation.terminalAt !== undefined;
    const sameIndex =
      previousIndexed &&
      nextIndexed &&
      previous.terminalAt === operation.terminalAt &&
      previous.terminalVersion === operation.terminalVersion;
    const partition = migrationGcPartition(
      `${teamId}/${operation.operationId}`,
    );
    if (previous) {
      for (const generation of this.controlReferencedGenerations(previous)) {
        tn.clear(
          this.controlGenerationRefKey(
            teamId,
            generation,
            previous.operationId,
          ),
        );
      }
      if (previousIndexed && !sameIndex) {
        const dueAt = previous.terminalAt! + MIGRATION_GC_MIN_RETENTION_MS;
        await this.clearGcIndexInTxn(
          tn,
          "control",
          partition,
          dueAt,
          this.controlGcKey(teamId, previous),
        );
      }
    }
    tn.set(
      this.controlOperationKey(teamId, operation.operationId),
      encodeJson(operation),
    );
    for (const generation of this.controlReferencedGenerations(operation)) {
      tn.set(
        this.controlGenerationRefKey(teamId, generation, operation.operationId),
        Buffer.alloc(0),
      );
    }
    if (nextIndexed && !sameIndex) {
      const dueAt = operation.terminalAt! + MIGRATION_GC_MIN_RETENTION_MS;
      await this.setGcIndexInTxn(
        tn,
        "control",
        partition,
        dueAt,
        this.controlGcKey(teamId, operation),
      );
    }
  }

  private async writePinInTxn(
    tn: Transaction,
    previous: MigrationObjectPin | null,
    pin: MigrationObjectPin,
  ): Promise<void> {
    const encoded = encodeJson(pin);
    tn.set(this.objectKey(pin.kind, pin.objectId), encoded);
    tn.set(this.generationObjectKey(pin), Buffer.alloc(0));
    const previousIndexed =
      previous?.lifecycle === "terminal" && previous.terminalAt !== undefined;
    const nextIndexed =
      pin.lifecycle === "terminal" && pin.terminalAt !== undefined;
    const sameIndex =
      previousIndexed &&
      nextIndexed &&
      previous.terminalAt === pin.terminalAt &&
      previous.terminalVersion === pin.terminalVersion &&
      previous.generation === pin.generation;
    const partition = migrationGcPartition(`${pin.kind}/${pin.objectId}`);
    if (pin.lifecycle === "terminal") {
      tn.clear(this.teamObjectKey(pin.teamId, pin.kind, pin.objectId));
    } else {
      tn.set(this.teamObjectKey(pin.teamId, pin.kind, pin.objectId), encoded);
    }
    if (previousIndexed && !sameIndex) {
      const dueAt = previous.terminalAt! + MIGRATION_GC_MIN_RETENTION_MS;
      await this.clearGcIndexInTxn(
        tn,
        "pin",
        partition,
        dueAt,
        this.terminalPinGcKey(previous),
      );
    }
    if (nextIndexed && !sameIndex) {
      const dueAt = pin.terminalAt! + MIGRATION_GC_MIN_RETENTION_MS;
      await this.setGcIndexInTxn(
        tn,
        "pin",
        partition,
        dueAt,
        this.terminalPinGcKey(pin),
      );
    }
  }

  private async readState(
    tn: Transaction,
    teamId: string,
  ): Promise<MigrationTeamState | null> {
    const value = await tn.get(this.teamStateKey(teamId));
    if (!value) return null;
    const state = validateTeamState(
      value && parseJson(value, `team ${teamId}`),
      `team ${teamId}`,
    );
    if (state.teamId !== teamId) {
      throw new MigrationCorruptionError(`team ${teamId}`, "team id mismatch");
    }
    return state;
  }

  private async readGeneration(
    tn: Transaction,
    teamId: string,
    generation: number,
  ): Promise<MigrationGeneration | null> {
    const record = `team ${teamId} generation ${generation}`;
    const value = await tn.get(this.generationKey(teamId, generation));
    if (!value) return null;
    const decoded = validateGeneration(parseJson(value, record), record);
    if (decoded.teamId !== teamId || decoded.generation !== generation) {
      throw new MigrationCorruptionError(record, "identity mismatch");
    }
    return decoded;
  }

  private async requireGeneration(
    tn: Transaction,
    teamId: string,
    generation: number,
  ): Promise<MigrationGeneration> {
    const value = await this.readGeneration(tn, teamId, generation);
    if (!value) {
      throw new MigrationCorruptionError(
        `team ${teamId} generation ${generation}`,
        "missing generation record",
      );
    }
    return value;
  }

  private async readResidue(
    tn: Transaction,
    teamId: string,
    generation: number,
  ): Promise<MigrationResidue> {
    const values = await Promise.all(
      MIGRATION_RESIDUE_COUNTERS.map(counter =>
        tn.get(this.residueKey(teamId, generation, counter)),
      ),
    );
    return Object.fromEntries(
      MIGRATION_RESIDUE_COUNTERS.map((counter, index) => [
        counter,
        decodeCounter(
          values[index],
          `team ${teamId} generation ${generation} residue ${counter}`,
        ),
      ]),
    ) as MigrationResidue;
  }

  private async applyResidueDelta(
    tn: Transaction,
    teamId: string,
    generation: number,
    from: MigrationResidue,
    to: MigrationResidue,
  ): Promise<void> {
    const changes = MIGRATION_RESIDUE_COUNTERS.flatMap(counter => {
      const delta = to[counter] - from[counter];
      if (!Number.isSafeInteger(delta)) {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_INVALID_ARGUMENT",
          `counter delta for ${counter} is not a safe integer`,
        );
      }
      return delta === 0 ? [] : [{ counter, delta }];
    });
    const current = await Promise.all(
      changes.map(({ counter }) =>
        tn.get(this.residueKey(teamId, generation, counter)),
      ),
    );
    for (let index = 0; index < changes.length; index++) {
      const { counter, delta } = changes[index];
      const key = this.residueKey(teamId, generation, counter);
      const value = decodeCounter(
        current[index],
        `team ${teamId} generation ${generation} residue ${counter}`,
      );
      if (!isNonnegativeInteger(value + delta)) {
        throw new MigrationCorruptionError(
          `team ${teamId} generation ${generation} residue ${counter}`,
          "pin delta would make counter negative or overflow",
        );
      }
      tn.add(key, encodeI64(delta));
    }
  }

  private async validateTopology(
    tn: Transaction,
    state: MigrationTeamState,
  ): Promise<void> {
    if (state.phase === "ERROR") return;
    const source = await this.requireGeneration(
      tn,
      state.teamId,
      state.activeGeneration,
    );
    if (source.backend !== state.activeBackend) {
      throw new MigrationCorruptionError(
        `team ${state.teamId}`,
        "active generation backend mismatch",
      );
    }
    if (state.phase === "PG_ONLY" || state.phase === "FDB_ONLY") {
      if (source.status !== "open") {
        throw new MigrationCorruptionError(
          `team ${state.teamId}`,
          "steady generation is not open",
        );
      }
      return;
    }
    const target = await this.requireGeneration(
      tn,
      state.teamId,
      state.targetGeneration!,
    );
    if (
      source.status !== "draining" ||
      target.status !== "closed" ||
      target.backend !== state.targetBackend
    ) {
      throw new MigrationCorruptionError(
        `team ${state.teamId}`,
        "transition generation topology mismatch",
      );
    }
  }

  public async inspectState(
    teamId: string,
  ): Promise<MigrationTeamState | null> {
    assertNonempty(teamId, "teamId");
    return await this.db.doTn(async tn => {
      const state = await this.readState(tn, teamId);
      if (state) await this.validateTopology(tn, state);
      return state;
    });
  }

  public async inspectGenerationIfPresent(
    teamId: string,
    generation: number,
  ): Promise<{
    generation: MigrationGeneration;
    residue: MigrationResidue;
  } | null> {
    assertNonempty(teamId, "teamId");
    if (!isPositiveInteger(generation)) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "generation must be a positive safe integer",
      );
    }
    return await this.db.doTn(async tn => {
      const record = await this.readGeneration(tn, teamId, generation);
      return record
        ? {
            generation: record,
            residue: await this.readResidue(tn, teamId, generation),
          }
        : null;
    });
  }

  public async inspectGeneration(
    teamId: string,
    generation: number,
  ): Promise<{ generation: MigrationGeneration; residue: MigrationResidue }> {
    assertNonempty(teamId, "teamId");
    if (!isPositiveInteger(generation)) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "generation must be a positive safe integer",
      );
    }
    return await this.db.doTn(async tn => ({
      generation: await this.requireGeneration(tn, teamId, generation),
      residue: await this.readResidue(tn, teamId, generation),
    }));
  }

  public async inspectTeamPinsPage(
    teamId: string,
    options: {
      limit: number;
      cursor?: { kind: MigrationObjectKind; objectId: string };
    },
  ): Promise<MigrationTeamPinsPage> {
    assertNonempty(teamId, "teamId");
    if (!isPositiveInteger(options.limit) || options.limit > 1000) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "pin page limit must be between 1 and 1000",
      );
    }
    if (options.cursor) {
      assertNonempty(options.cursor.objectId, "cursor.objectId");
      if (!OBJECT_KINDS.includes(options.cursor.kind)) {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_INVALID_ARGUMENT",
          "cursor.kind is invalid",
        );
      }
    }
    return await this.db.doTn(async tn => {
      const range = getFdb().tuple.range([
        "nuq-migration",
        1,
        "team",
        teamId,
        "object",
      ]);
      const begin = options.cursor
        ? Buffer.concat([
            this.teamObjectKey(
              teamId,
              options.cursor.kind,
              options.cursor.objectId,
            ),
            Buffer.from([0]),
          ])
        : (range.begin as Buffer);
      const rows = await tn
        .snapshot()
        .getRangeAll(begin, range.end as Buffer, { limit: options.limit });
      const indexed: MigrationObjectPin[] = [];
      for (const [key, value] of rows) {
        const pin = validatePin(
          parseJson(value as Buffer, `team ${teamId} active object index`),
          `team ${teamId} active object index`,
        );
        if (
          pin.teamId !== teamId ||
          !(key as Buffer).equals(
            this.teamObjectKey(teamId, pin.kind, pin.objectId),
          )
        ) {
          throw new MigrationCorruptionError(
            `team ${teamId} active object index`,
            "identity mismatch",
          );
        }
        if (pin.lifecycle === "terminal") {
          const globalRaw = await tn.get(
            this.objectKey(pin.kind, pin.objectId),
          );
          const global = globalRaw
            ? validatePin(
                parseJson(globalRaw, `object ${pin.kind}/${pin.objectId}`),
                `object ${pin.kind}/${pin.objectId}`,
              )
            : null;
          if (!global || JSON.stringify(global) !== JSON.stringify(pin)) {
            throw new MigrationCorruptionError(
              `team ${teamId} active object index`,
              "terminal tombstone mismatch",
            );
          }
          // Compact indexes written by the prototype before this became an
          // active-only index. The global tombstone remains routing authority.
          tn.clear(key as Buffer);
        }
        indexed.push(pin);
      }
      const last = indexed.at(-1);
      return {
        pins: indexed.filter(pin => pin.lifecycle !== "terminal"),
        ...(rows.length === options.limit && last
          ? { nextCursor: { kind: last.kind, objectId: last.objectId } }
          : {}),
      };
    });
  }

  public async inspectPin(
    kind: MigrationObjectKind,
    objectId: string,
  ): Promise<MigrationObjectPin | null> {
    assertNonempty(objectId, "objectId");
    return await this.db.doTn(async tn =>
      this.inspectPinInTxn(tn, kind, objectId),
    );
  }

  public async inspectPinInTxn(
    tn: Transaction,
    kind: MigrationObjectKind,
    objectId: string,
  ): Promise<MigrationObjectPin | null> {
    const record = `object ${kind}/${objectId}`;
    const value = await tn.get(this.objectKey(kind, objectId));
    if (!value) return null;
    const pin = validatePin(parseJson(value, record), record);
    if (pin.kind !== kind || pin.objectId !== objectId) {
      throw new MigrationCorruptionError(record, "identity mismatch");
    }
    return pin;
  }

  private async validateTeamPinIndex(
    tn: Transaction,
    pin: MigrationObjectPin,
    record: string,
  ): Promise<void> {
    const indexedRaw = await tn.get(
      this.teamObjectKey(pin.teamId, pin.kind, pin.objectId),
    );
    if (pin.lifecycle === "terminal") {
      if (indexedRaw) {
        const indexed = validatePin(
          parseJson(indexedRaw, `${record} team index`),
          `${record} team index`,
        );
        if (JSON.stringify(indexed) !== JSON.stringify(pin)) {
          throw new MigrationCorruptionError(record, "team pin index mismatch");
        }
        // Upgrade old terminal index entries in-place while preserving the
        // global tombstone used for deterministic routing.
        tn.clear(this.teamObjectKey(pin.teamId, pin.kind, pin.objectId));
      }
      return;
    }
    if (!indexedRaw) {
      throw new MigrationCorruptionError(record, "missing team pin index");
    }
    const indexed = validatePin(
      parseJson(indexedRaw, `${record} team index`),
      `${record} team index`,
    );
    if (JSON.stringify(indexed) !== JSON.stringify(pin)) {
      throw new MigrationCorruptionError(record, "team pin index mismatch");
    }
  }

  public async validatePinnedObjectInTxn(
    tn: Transaction,
    input: {
      teamId: string;
      kind: MigrationObjectKind;
      objectId: string;
      backend?: MigrationBackend;
      generation?: number;
    },
  ): Promise<MigrationObjectPin> {
    const { teamId, kind, objectId } = input;
    const record = `object ${kind}/${objectId}`;
    const pin = await this.inspectPinInTxn(tn, kind, objectId);
    if (!pin) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_PIN_NOT_FOUND",
        `${kind}/${objectId} has no durable pin`,
      );
    }
    if (
      pin.teamId !== teamId ||
      (input.backend !== undefined && pin.backend !== input.backend) ||
      (input.generation !== undefined && pin.generation !== input.generation)
    ) {
      throw new MigrationCorruptionError(record, "pin expectation mismatch");
    }
    if (pin.lifecycle === "terminal") {
      throw new MigrationStaleGenerationError(
        teamId,
        pin.backend,
        pin.generation,
      );
    }
    await this.validateTeamPinIndex(tn, pin, record);
    const generation = await this.requireGeneration(tn, teamId, pin.generation);
    if (
      generation.backend !== pin.backend ||
      (generation.status !== "open" && generation.status !== "draining")
    ) {
      throw new MigrationStaleGenerationError(
        teamId,
        pin.backend,
        pin.generation,
      );
    }
    return pin;
  }

  /**
   * Composes migration accounting with a queue/group/slot mutation. Teams that
   * have never entered the migration control plane remain untouched. Once a
   * team state exists, the durable object pin and the pin copied onto an
   * existing runtime record are mandatory. Explicit legacy-backfill pins are
   * the sole exception for records written before runtime pins existed.
   * Reading the generation and residue keys here gives finalSeal a conflict
   * with every residue increase.
   */
  public async reconcileManagedObjectInTxn(
    tn: Transaction,
    input: ReconcileManagedObjectInput,
  ): Promise<MigrationObjectPin | null> {
    const { teamId, kind, objectId } = input;
    assertNonempty(teamId, "teamId");
    assertNonempty(objectId, "objectId");
    const state = await this.readState(tn, teamId);
    if (!state) {
      if (input.recordPin) {
        throw new MigrationCorruptionError(
          `object ${kind}/${objectId}`,
          "runtime generation pin exists without team migration state",
        );
      }
      return null;
    }
    await this.validateTopology(tn, state);
    const residue = normalizeResidue(input.residue);
    const terminal = input.terminal === true;
    let pin = await this.inspectPinInTxn(tn, kind, objectId);
    let adoptedLegacyRecord = false;
    if (
      !pin &&
      kind === "group" &&
      terminal &&
      input.cancelledGroupContinuation === true &&
      !input.recordPin &&
      !input.allowMissingRecordPin
    ) {
      // A cancelled legacy group is not terminal migration residue until its
      // sweeper continuation has completed. Adopt both controls atomically so
      // a crash cannot strand an active group pin without discoverable work.
      pin = await this.preparePinnedObjectInTxn(tn, {
        teamId,
        kind,
        objectId,
        admission: {
          type: "legacy-backfill",
          backend: "fdb",
          generation: state.activeGeneration,
        },
        requiredBackend: "fdb",
        residue,
      });
      pin = (await this.reconcileManagedObjectInTxn(tn, {
        teamId,
        kind,
        objectId,
        recordPin: { backend: pin.backend, generation: pin.generation },
        residue,
      }))!;
      const taskObjectId = `group-cancel/${objectId}`;
      await this.preparePinnedObjectInTxn(tn, {
        teamId,
        kind: "sweeper_task",
        objectId: taskObjectId,
        admission: {
          type: "pinned-continuation",
          source: { kind: "group", objectId },
        },
        requiredBackend: "fdb",
        residue: { control_sweeper_tasks: 1 },
      });
      const taskPin = await this.inspectPinInTxn(
        tn,
        "sweeper_task",
        taskObjectId,
      );
      if (!taskPin) {
        throw new MigrationCorruptionError(
          `object sweeper_task/${taskObjectId}`,
          "prepared continuation disappeared in its transaction",
        );
      }
      await this.reconcileManagedObjectInTxn(tn, {
        teamId,
        kind: "sweeper_task",
        objectId: taskObjectId,
        recordPin: {
          backend: taskPin.backend,
          generation: taskPin.generation,
        },
        residue: { control_sweeper_tasks: 1 },
      });
      return pin;
    }
    if (!pin) {
      // Callers set allowMissingRecordPin only while creating a new runtime
      // record, which must already have a router-prepared intent. Mutations of
      // an existing pre-protocol record may adopt the active source generation
      // explicitly; this cannot reopen new-root admission while draining.
      if (input.recordPin || input.allowMissingRecordPin) {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_PIN_NOT_FOUND",
          `${kind}/${objectId} has no durable pin`,
        );
      }
      const generation = terminal
        ? await this.ensureTerminalLegacyGenerationInTxn(tn, state, "fdb")
        : state.activeGeneration;
      pin = await this.preparePinnedObjectInTxn(tn, {
        teamId,
        kind,
        objectId,
        admission: {
          type: "legacy-backfill",
          backend: "fdb",
          generation,
          terminal,
        },
        requiredBackend: "fdb",
        residue,
      });
      adoptedLegacyRecord = true;
    }
    if (
      !input.recordPin &&
      !input.allowMissingRecordPin &&
      pin.admission !== "legacy-backfill"
    ) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_RUNTIME_PIN_MISSING",
        `${kind}/${objectId} is missing its runtime generation pin`,
      );
    }
    if (
      pin.teamId !== teamId ||
      pin.backend !== "fdb" ||
      (input.recordPin !== undefined &&
        (input.recordPin.backend !== pin.backend ||
          input.recordPin.generation !== pin.generation))
    ) {
      throw new MigrationCorruptionError(
        `object ${kind}/${objectId}`,
        "runtime and durable pin mismatch",
      );
    }
    const generation = await this.requireGeneration(tn, teamId, pin.generation);
    const terminalIdempotent =
      pin.lifecycle === "terminal" &&
      terminal &&
      Object.values(residue).every(value => value === 0);
    if (
      generation.backend !== pin.backend ||
      (generation.status !== "open" &&
        generation.status !== "draining" &&
        !terminalIdempotent)
    ) {
      throw new MigrationStaleGenerationError(
        teamId,
        pin.backend,
        pin.generation,
      );
    }
    const targetLifecycle: MigrationObjectLifecycle = terminal
      ? "terminal"
      : input.activateNonterminal === false && !adoptedLegacyRecord
        ? pin.lifecycle
        : "active";
    if (pin.lifecycle === "terminal") {
      await this.validateTeamPinIndex(tn, pin, `object ${kind}/${objectId}`);
      if (!terminal || Object.values(residue).some(value => value !== 0)) {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_LIFECYCLE_MISMATCH",
          `${kind}/${objectId} tombstone cannot be reopened`,
        );
      }
      return pin;
    }
    await this.validateTeamPinIndex(tn, pin, `object ${kind}/${objectId}`);
    if (
      pin.lifecycle === targetLifecycle &&
      residueEqual(pin.residue, residue)
    ) {
      return pin;
    }
    await this.applyResidueDelta(
      tn,
      teamId,
      pin.generation,
      pin.residue,
      residue,
    );
    const revision = pin.revision + 1;
    if (!Number.isSafeInteger(revision)) {
      throw new MigrationCorruptionError(
        `object ${kind}/${objectId}`,
        "pin revision exhausted",
      );
    }
    const next: MigrationObjectPin = {
      ...pin,
      lifecycle: targetLifecycle,
      revision,
      residue,
      ...(targetLifecycle === "terminal"
        ? { terminalAt: Date.now(), terminalVersion: revision }
        : {}),
    };
    await this.writePinInTxn(tn, pin, next);
    return next;
  }

  public async validateManagedObjectInTxn(
    tn: Transaction,
    input: Omit<ReconcileManagedObjectInput, "residue" | "terminal"> & {
      legacyResidue?: Partial<MigrationResidue>;
    },
  ): Promise<MigrationObjectPin | null> {
    const pin = await this.inspectPinInTxn(tn, input.kind, input.objectId);
    const { legacyResidue, ...reconcileInput } = input;
    return await this.reconcileManagedObjectInTxn(tn, {
      ...reconcileInput,
      residue: pin?.residue ?? legacyResidue ?? {},
      activateNonterminal: false,
    });
  }

  public async resolveSteady(
    teamId: string,
    desiredBackend: MigrationBackend,
  ): Promise<MigrationSteadyResolution> {
    assertNonempty(teamId, "teamId");
    return await this.db.doTn(async tn => {
      const state = await this.readState(tn, teamId);
      if (!state) return { status: "legacy-uninitialized" } as const;
      await this.validateTopology(tn, state);
      if (state.phase === "ERROR") {
        throw new MigrationCorruptionError(
          `team ${teamId}`,
          "team is in ERROR phase",
        );
      }
      if (state.phase === "PG_ONLY" || state.phase === "FDB_ONLY") {
        return state.activeBackend === desiredBackend
          ? ({ status: "steady", state } as const)
          : ({ status: "transition-required", state } as const);
      }
      return state.targetBackend === desiredBackend
        ? ({ status: "transitioning", state } as const)
        : ({ status: "cancel-required", state } as const);
    });
  }

  // Legacy state is never guessed from Redis or today's flag. A caller must
  // explicitly name the authoritative backend once.
  public async initializeLegacyTeam(
    teamId: string,
    backend: MigrationBackend,
    operationId: string,
    options?: { ifAbsent?: boolean },
  ): Promise<MigrationTeamState> {
    assertNonempty(teamId, "teamId");
    assertNonempty(operationId, "operationId");
    return await this.db.doTn(async tn => {
      await this.assertCoreReadinessInTxn(tn);
      const opKey = this.controlOperationKey(teamId, operationId);
      const rawOp = await tn.get(opKey);
      if (rawOp) {
        const op = validateControlOperation(
          parseJson(rawOp, `control operation ${operationId}`),
          `control operation ${operationId}`,
        );
        if (op.operationId !== operationId || op.state.teamId !== teamId) {
          throw new MigrationCorruptionError(
            `control operation ${operationId}`,
            "identity mismatch",
          );
        }
        if (op.kind !== "initialize" || op.backend !== backend) {
          throw new MigrationOperationConflictError(operationId);
        }
        if (options?.ifAbsent) {
          const current = await this.readState(tn, teamId);
          if (!current) {
            throw new MigrationCorruptionError(
              `control operation ${operationId}`,
              "initialize operation exists without team state",
            );
          }
          await this.validateTopology(tn, current);
          return current;
        }
        return op.state;
      }
      const existing = await this.readState(tn, teamId);
      if (existing) {
        await this.validateTopology(tn, existing);
        if (options?.ifAbsent) return existing;
        throw new MigrationStoreError(
          "NUQ_MIGRATION_ALREADY_INITIALIZED",
          `team ${teamId} is already initialized`,
        );
      }
      const state: MigrationTeamState = {
        schemaVersion: 1,
        teamId,
        revision: 1,
        maxGeneration: 1,
        activeBackend: backend,
        activeGeneration: 1,
        phase: stablePhase(backend),
      };
      const generation: MigrationGeneration = {
        schemaVersion: 1,
        teamId,
        backend,
        generation: 1,
        status: "open",
        gcIndexed: true,
      };
      const op: ControlOperation = {
        schemaVersion: 1,
        kind: "initialize",
        operationId,
        backend,
        outcome: "completed",
        state,
        terminalAt: Date.now(),
        terminalVersion: state.revision,
      };
      tn.set(this.teamStateKey(teamId), encodeJson(state));
      await this.writeGenerationInTxn(tn, null, generation);
      await this.writeControlOperationInTxn(tn, teamId, null, op);
      return state;
    });
  }

  private async ensureTerminalLegacyGenerationInTxn(
    tn: Transaction,
    state: MigrationTeamState,
    backend: MigrationBackend,
  ): Promise<number> {
    const { teamId } = state;
    if (state.activeBackend === backend) return state.activeGeneration;
    for (let candidate = state.maxGeneration; candidate >= 1; candidate--) {
      const generation = await this.readGeneration(tn, teamId, candidate);
      if (generation?.backend === backend) return candidate;
    }
    if (state.phase !== "PG_ONLY" && state.phase !== "FDB_ONLY") {
      throw new MigrationInProgressError(teamId);
    }
    const generationNumber = state.maxGeneration + 1;
    if (!Number.isSafeInteger(generationNumber)) {
      throw new MigrationCorruptionError(
        `team ${teamId}`,
        "generation exhausted safe integer range",
      );
    }
    if (await this.readGeneration(tn, teamId, generationNumber)) {
      throw new MigrationCorruptionError(
        `team ${teamId} generation ${generationNumber}`,
        "generation was previously allocated beyond maxGeneration",
      );
    }
    const generation: MigrationGeneration = {
      schemaVersion: 1,
      teamId,
      backend,
      generation: generationNumber,
      status: "closed",
      gcIndexed: true,
      terminalAt: Date.now(),
      terminalVersion: nextRevision(state),
    };
    const next: MigrationTeamState = {
      ...state,
      revision: nextRevision(state),
      maxGeneration: generationNumber,
    };
    await this.writeGenerationInTxn(tn, null, generation);
    tn.set(this.teamStateKey(teamId), encodeJson(next));
    return generationNumber;
  }

  /** Allocates at most one closed historical generation for terminal runtime
   * records discovered after authority initialization. It never changes the
   * active backend and is idempotent across commit-unknown retries. */
  public async ensureTerminalLegacyGeneration(
    teamId: string,
    backend: MigrationBackend,
  ): Promise<number> {
    assertNonempty(teamId, "teamId");
    return await this.db.doTn(async tn => {
      const state = await this.readState(tn, teamId);
      if (!state) throw new MigrationLegacyStateError(teamId);
      await this.validateTopology(tn, state);
      return await this.ensureTerminalLegacyGenerationInTxn(tn, state, backend);
    });
  }

  public async beginTransition(input: {
    teamId: string;
    targetBackend: MigrationBackend;
    operationId: string;
    expectedRevision?: number;
  }): Promise<MigrationTeamState> {
    const { teamId, targetBackend, operationId, expectedRevision } = input;
    assertNonempty(teamId, "teamId");
    assertNonempty(operationId, "operationId");
    return await this.db.doTn(async tn => {
      await this.assertCoreReadinessInTxn(tn);
      const opKey = this.controlOperationKey(teamId, operationId);
      const rawOp = await tn.get(opKey);
      if (rawOp) {
        const op = validateControlOperation(
          parseJson(rawOp, `control operation ${operationId}`),
          `control operation ${operationId}`,
        );
        if (op.operationId !== operationId || op.state.teamId !== teamId) {
          throw new MigrationCorruptionError(
            `control operation ${operationId}`,
            "identity mismatch",
          );
        }
        if (op.kind !== "begin" || op.backend !== targetBackend) {
          throw new MigrationOperationConflictError(operationId);
        }
        return op.state;
      }
      const state = await this.readState(tn, teamId);
      if (!state) throw new MigrationLegacyStateError(teamId);
      if (
        expectedRevision !== undefined &&
        state.revision !== expectedRevision
      ) {
        throw new MigrationCasError(expectedRevision, state.revision);
      }
      if (state.phase !== "PG_ONLY" && state.phase !== "FDB_ONLY") {
        throw new MigrationInProgressError(teamId);
      }
      await this.validateTopology(tn, state);
      if (state.activeBackend === targetBackend) {
        const op: ControlOperation = {
          schemaVersion: 1,
          kind: "begin",
          operationId,
          backend: targetBackend,
          outcome: "completed",
          state,
          terminalAt: Date.now(),
          terminalVersion: state.revision,
        };
        await this.writeControlOperationInTxn(tn, teamId, null, op);
        return state;
      }

      const source = await this.requireGeneration(
        tn,
        teamId,
        state.activeGeneration,
      );
      if (source.status !== "open" || source.backend !== state.activeBackend) {
        throw new MigrationCorruptionError(
          `team ${teamId} generation ${source.generation}`,
          "active generation is not open",
        );
      }
      const targetGeneration = state.maxGeneration + 1;
      if (!Number.isSafeInteger(targetGeneration)) {
        throw new MigrationCorruptionError(
          `team ${teamId}`,
          "generation exhausted safe integer range",
        );
      }
      if (await this.readGeneration(tn, teamId, targetGeneration)) {
        throw new MigrationCorruptionError(
          `team ${teamId} generation ${targetGeneration}`,
          "generation was previously allocated beyond maxGeneration",
        );
      }
      const drainingSource: MigrationGeneration = {
        ...source,
        status: "draining",
      };
      const transitionRevision = nextRevision(state);
      const target: MigrationGeneration = {
        schemaVersion: 1,
        teamId,
        backend: targetBackend,
        generation: targetGeneration,
        // A target remains closed until the source reaches exact zero. If the
        // transition is cancelled this generation stays closed forever.
        status: "closed",
        gcIndexed: true,
        terminalAt: Date.now(),
        terminalVersion: transitionRevision,
      };
      const next: MigrationTeamState = {
        ...state,
        revision: transitionRevision,
        maxGeneration: targetGeneration,
        phase: drainingPhase(targetBackend),
        targetBackend,
        targetGeneration,
        transitionOperationId: operationId,
      };
      const op: ControlOperation = {
        schemaVersion: 1,
        kind: "begin",
        operationId,
        backend: targetBackend,
        outcome: "pending",
        state: next,
      };
      await this.writeGenerationInTxn(tn, source, drainingSource);
      await this.writeGenerationInTxn(tn, null, target);
      tn.set(this.teamStateKey(teamId), encodeJson(next));
      await this.writeControlOperationInTxn(tn, teamId, null, op);
      return next;
    });
  }

  public async cancelTransition(input: {
    teamId: string;
    transitionOperationId: string;
    expectedRevision?: number;
  }): Promise<MigrationTeamState> {
    const { teamId, transitionOperationId, expectedRevision } = input;
    assertNonempty(teamId, "teamId");
    assertNonempty(transitionOperationId, "transitionOperationId");
    return await this.db.doTn(async tn => {
      const opKey = this.controlOperationKey(teamId, transitionOperationId);
      const rawOp = await tn.get(opKey);
      if (!rawOp) {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      const op = validateControlOperation(
        parseJson(rawOp, `control operation ${transitionOperationId}`),
        `control operation ${transitionOperationId}`,
      );
      if (
        op.operationId !== transitionOperationId ||
        op.state.teamId !== teamId
      ) {
        throw new MigrationCorruptionError(
          `control operation ${transitionOperationId}`,
          "identity mismatch",
        );
      }
      if (op.kind !== "begin") {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      if (op.outcome === "cancelled") return op.state;
      if (op.outcome === "completed") {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_ALREADY_SEALED",
          `transition ${transitionOperationId} is already sealed`,
        );
      }
      const state = await this.readState(tn, teamId);
      if (!state) throw new MigrationLegacyStateError(teamId);
      if (
        expectedRevision !== undefined &&
        state.revision !== expectedRevision
      ) {
        throw new MigrationCasError(expectedRevision, state.revision);
      }
      if (state.transitionOperationId !== transitionOperationId) {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      const source = await this.requireGeneration(
        tn,
        teamId,
        state.activeGeneration,
      );
      const target = await this.requireGeneration(
        tn,
        teamId,
        state.targetGeneration!,
      );
      const targetResidue = await this.readResidue(
        tn,
        teamId,
        target.generation,
      );
      if (
        source.status !== "draining" ||
        source.backend !== state.activeBackend ||
        target.status !== "closed" ||
        target.backend !== state.targetBackend ||
        Object.values(targetResidue).some(value => value !== 0)
      ) {
        throw new MigrationCorruptionError(
          `team ${teamId}`,
          "transition generations cannot be cancelled",
        );
      }
      const reopened: MigrationGeneration = {
        ...source,
        status: "open",
        terminalAt: undefined,
        terminalVersion: undefined,
      };
      const next: MigrationTeamState = {
        schemaVersion: 1,
        teamId,
        revision: nextRevision(state),
        maxGeneration: state.maxGeneration,
        activeBackend: state.activeBackend,
        activeGeneration: state.activeGeneration,
        phase: stablePhase(state.activeBackend),
      };
      const cancelledOp: ControlOperation = {
        ...op,
        outcome: "cancelled",
        state: next,
        terminalAt: Date.now(),
        terminalVersion: next.revision,
      };
      await this.writeGenerationInTxn(tn, source, reopened);
      tn.set(this.teamStateKey(teamId), encodeJson(next));
      await this.writeControlOperationInTxn(tn, teamId, op, cancelledOp);
      return next;
    });
  }

  public async preparePinnedObject(
    input: PreparePinnedObjectInput,
  ): Promise<MigrationObjectPin> {
    return (await this.preparePinnedObjects([input]))[0];
  }

  public async preparePinnedObjects(
    inputs: readonly PreparePinnedObjectInput[],
  ): Promise<MigrationObjectPin[]> {
    return await this.db.doTn(async tn => {
      const pins: MigrationObjectPin[] = [];
      for (const input of inputs) {
        pins.push(await this.preparePinnedObjectInTxn(tn, input));
      }
      return pins;
    });
  }

  // Transaction-scoped hook for queue/group/slot/sweeper code. The caller can
  // validate and account for a generation in the same FDB transaction as the
  // mutation that creates residue. An existing object ID is an idempotent
  // replay and may already be active/terminal, so the composing mutation must
  // also reconcile by its stable object ID rather than blindly recreate work.
  public async preparePinnedObjectInTxn(
    tn: Transaction,
    input: PreparePinnedObjectInput,
  ): Promise<MigrationObjectPin> {
    const { teamId, kind, objectId, admission, requiredBackend } = input;
    assertNonempty(teamId, "teamId");
    assertNonempty(objectId, "objectId");
    const initialResidue = normalizeResidue(input.residue);
    const key = this.objectKey(kind, objectId);
    const indexKey = this.teamObjectKey(teamId, kind, objectId);
    const rawPin = await tn.get(key);
    const rawIndex = await tn.get(indexKey);
    if (rawPin) {
      const record = `object ${kind}/${objectId}`;
      const pin = validatePin(parseJson(rawPin, record), record);
      const expectedAdmission = admission.type;
      if (
        pin.teamId !== teamId ||
        pin.kind !== kind ||
        pin.objectId !== objectId ||
        pin.admission !== expectedAdmission ||
        !residueEqual(pin.initialResidue, initialResidue) ||
        (requiredBackend !== undefined && pin.backend !== requiredBackend) ||
        (admission.type === "pinned-continuation" &&
          (pin.sourceKind !== admission.source.kind ||
            pin.sourceObjectId !== admission.source.objectId)) ||
        (admission.type === "legacy-backfill" &&
          (pin.backend !== admission.backend ||
            pin.generation !== admission.generation ||
            (pin.lifecycle === "terminal") !== (admission.terminal === true)))
      ) {
        throw new MigrationOperationConflictError(`${kind}/${objectId}`);
      }
      await this.validateTeamPinIndex(tn, pin, record);
      return pin;
    }
    if (rawIndex) {
      throw new MigrationCorruptionError(
        `object ${kind}/${objectId}`,
        "orphaned team pin index",
      );
    }
    const state = await this.readState(tn, teamId);
    if (!state) throw new MigrationLegacyStateError(teamId);
    let backend: MigrationBackend;
    let generationNumber: number;
    if (admission.type === "new-root") {
      if (state.phase !== "PG_ONLY" && state.phase !== "FDB_ONLY") {
        throw new MigrationInProgressError(teamId);
      }
      backend = state.activeBackend;
      generationNumber = state.activeGeneration;
    } else if (admission.type === "legacy-backfill") {
      backend = admission.backend;
      generationNumber = admission.generation;
      if (
        admission.terminal !== true &&
        (state.activeBackend !== backend ||
          state.activeGeneration !== generationNumber)
      ) {
        throw new MigrationStaleGenerationError(
          teamId,
          backend,
          generationNumber,
        );
      }
    } else {
      assertNonempty(admission.source.objectId, "admission.source.objectId");
      const sourceRecord = `source object ${admission.source.kind}/${admission.source.objectId}`;
      const sourceRaw = await tn.get(
        this.objectKey(admission.source.kind, admission.source.objectId),
      );
      if (!sourceRaw) {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_SOURCE_PIN_NOT_FOUND",
          `${admission.source.kind}/${admission.source.objectId} has no durable source pin`,
        );
      }
      const sourcePin = validatePin(
        parseJson(sourceRaw, sourceRecord),
        sourceRecord,
      );
      if (
        sourcePin.teamId !== teamId ||
        sourcePin.kind !== admission.source.kind ||
        sourcePin.objectId !== admission.source.objectId
      ) {
        throw new MigrationCorruptionError(sourceRecord, "identity mismatch");
      }
      if (sourcePin.lifecycle === "terminal") {
        throw new MigrationStaleGenerationError(
          teamId,
          sourcePin.backend,
          sourcePin.generation,
        );
      }
      await this.validateTeamPinIndex(tn, sourcePin, sourceRecord);
      backend = sourcePin.backend;
      generationNumber = sourcePin.generation;
    }
    if (requiredBackend !== undefined && backend !== requiredBackend) {
      throw new MigrationStaleGenerationError(
        teamId,
        requiredBackend,
        generationNumber,
      );
    }
    const generation = await this.requireGeneration(
      tn,
      teamId,
      generationNumber,
    );
    const terminalLegacyBackfill =
      admission.type === "legacy-backfill" && admission.terminal === true;
    if (
      terminalLegacyBackfill &&
      Object.values(initialResidue).some(value => value !== 0)
    ) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "terminal legacy backfill cannot carry residue",
      );
    }
    const allowed =
      generation.backend === backend &&
      (terminalLegacyBackfill ||
        (admission.type === "new-root"
          ? generation.status === "open"
          : generation.status === "open" || generation.status === "draining"));
    if (!allowed) {
      throw new MigrationStaleGenerationError(
        teamId,
        backend,
        generationNumber,
      );
    }
    const pin: MigrationObjectPin = {
      schemaVersion: 1,
      teamId,
      kind,
      objectId,
      backend,
      generation: generationNumber,
      lifecycle: terminalLegacyBackfill ? "terminal" : "prepared",
      revision: 1,
      admission: admission.type,
      sourceKind:
        admission.type === "pinned-continuation"
          ? admission.source.kind
          : undefined,
      sourceObjectId:
        admission.type === "pinned-continuation"
          ? admission.source.objectId
          : undefined,
      initialResidue,
      residue: initialResidue,
      ...(terminalLegacyBackfill
        ? { terminalAt: Date.now(), terminalVersion: 1 }
        : {}),
    };
    await this.applyResidueDelta(
      tn,
      teamId,
      generationNumber,
      normalizeResidue(undefined),
      initialResidue,
    );
    await this.writePinInTxn(tn, null, pin);
    return pin;
  }

  public async transitionObjectResidue(
    input: TransitionObjectResidueInput,
  ): Promise<MigrationObjectPin> {
    return await this.db.doTn(async tn =>
      this.transitionObjectResidueInTxn(tn, input),
    );
  }

  public async transitionObjectResidueInTxn(
    tn: Transaction,
    input: TransitionObjectResidueInput,
  ): Promise<MigrationObjectPin> {
    const {
      teamId,
      kind,
      objectId,
      operationId,
      fromLifecycle,
      toLifecycle,
      expectedRevision,
    } = input;
    assertNonempty(teamId, "teamId");
    assertNonempty(objectId, "objectId");
    assertNonempty(operationId, "operationId");
    if (
      expectedRevision !== undefined &&
      !isPositiveInteger(expectedRevision)
    ) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "expectedRevision must be a positive safe integer",
      );
    }
    const residue = normalizeResidue(input.residue);
    const key = this.objectKey(kind, objectId);
    const record = `object ${kind}/${objectId}`;
    const rawPin = await tn.get(key);
    if (!rawPin) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_PIN_NOT_FOUND",
        `${kind}/${objectId} has no durable pin`,
      );
    }
    const pin = validatePin(parseJson(rawPin, record), record);
    if (
      pin.teamId !== teamId ||
      pin.kind !== kind ||
      pin.objectId !== objectId
    ) {
      throw new MigrationCorruptionError(record, "identity mismatch");
    }
    if (pin.lastOperation?.operationId === operationId) {
      if (
        pin.lastOperation.fromLifecycle !== fromLifecycle ||
        pin.lastOperation.toLifecycle !== toLifecycle ||
        !residueEqual(pin.lastOperation.residue, residue)
      ) {
        throw new MigrationOperationConflictError(operationId);
      }
      await this.validateTeamPinIndex(tn, pin, record);
      return {
        ...pin,
        lifecycle: pin.lastOperation.toLifecycle,
        revision: pin.lastOperation.resultRevision,
        residue: pin.lastOperation.residue,
      };
    }

    const legacyOperationKey = this.legacyObjectOperationKey(
      teamId,
      kind,
      objectId,
      operationId,
    );
    const legacyOperationRaw = await tn.get(legacyOperationKey);
    if (legacyOperationRaw) {
      const legacyOperation = validateLegacyObjectOperation(
        parseJson(legacyOperationRaw, `legacy object operation ${operationId}`),
        `legacy object operation ${operationId}`,
      );
      if (
        legacyOperation.operationId !== operationId ||
        legacyOperation.teamId !== teamId ||
        legacyOperation.kind !== kind ||
        legacyOperation.objectId !== objectId ||
        legacyOperation.fromLifecycle !== fromLifecycle ||
        legacyOperation.toLifecycle !== toLifecycle ||
        !residueEqual(legacyOperation.residue, residue)
      ) {
        throw new MigrationOperationConflictError(operationId);
      }
      if (
        legacyOperation.result.backend !== pin.backend ||
        legacyOperation.result.generation !== pin.generation ||
        legacyOperation.result.admission !== pin.admission ||
        legacyOperation.result.sourceKind !== pin.sourceKind ||
        legacyOperation.result.sourceObjectId !== pin.sourceObjectId ||
        !residueEqual(
          legacyOperation.result.initialResidue,
          pin.initialResidue,
        ) ||
        legacyOperation.result.revision > pin.revision ||
        (legacyOperation.result.revision === pin.revision &&
          (legacyOperation.result.lifecycle !== pin.lifecycle ||
            !residueEqual(legacyOperation.result.residue, pin.residue)))
      ) {
        throw new MigrationCorruptionError(
          record,
          "legacy operation does not describe this pin revision history",
        );
      }
      await this.validateTeamPinIndex(tn, pin, record);
      if (!pin.lastOperation) {
        const migratedPin: MigrationObjectPin = {
          ...pin,
          lastOperation: {
            schemaVersion: 1,
            operationId,
            fromLifecycle,
            toLifecycle,
            residue,
            resultRevision: legacyOperation.result.revision,
          },
        };
        await this.writePinInTxn(tn, pin, migratedPin);
        tn.clear(legacyOperationKey);
      }
      return legacyOperation.result;
    }
    if (expectedRevision !== undefined && pin.revision !== expectedRevision) {
      throw new MigrationCasError(expectedRevision, pin.revision);
    }
    if (pin.lifecycle !== fromLifecycle) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_LIFECYCLE_MISMATCH",
        `${kind}/${objectId} expected ${fromLifecycle}, found ${pin.lifecycle}`,
      );
    }
    if (pin.lifecycle === "terminal" && toLifecycle !== "terminal") {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_LIFECYCLE_MISMATCH",
        `${kind}/${objectId} tombstone cannot be reopened`,
      );
    }
    const generation = await this.requireGeneration(tn, teamId, pin.generation);
    if (generation.backend !== pin.backend) {
      throw new MigrationCorruptionError(
        record,
        "pin backend does not match generation",
      );
    }
    if (generation.status === "closed") {
      throw new MigrationStaleGenerationError(
        teamId,
        pin.backend,
        pin.generation,
      );
    }
    await this.validateTeamPinIndex(tn, pin, record);
    await this.applyResidueDelta(
      tn,
      teamId,
      pin.generation,
      pin.residue,
      residue,
    );
    const revision = pin.revision + 1;
    if (!Number.isSafeInteger(revision)) {
      throw new MigrationCorruptionError(record, "pin revision exhausted");
    }
    const next: MigrationObjectPin = {
      ...pin,
      lifecycle: toLifecycle,
      revision,
      residue,
      ...(toLifecycle === "terminal"
        ? { terminalAt: Date.now(), terminalVersion: revision }
        : {}),
      lastOperation: {
        schemaVersion: 1,
        operationId,
        fromLifecycle,
        toLifecycle,
        residue,
        resultRevision: revision,
      },
    };
    await this.writePinInTxn(tn, pin, next);
    return next;
  }

  public async completePinnedObject(
    input: CompletePinnedObjectInput,
  ): Promise<MigrationObjectPin> {
    return await this.transitionObjectResidue({
      ...input,
      toLifecycle: "terminal",
      residue: {},
    });
  }

  public async completePinnedObjectInTxn(
    tn: Transaction,
    input: CompletePinnedObjectInput,
  ): Promise<MigrationObjectPin> {
    return await this.transitionObjectResidueInTxn(tn, {
      ...input,
      toLifecycle: "terminal",
      residue: {},
    });
  }

  private gcCategoryRange(
    category: MigrationGcCategory,
    partition: number,
    through: number,
  ) {
    return category === "pin"
      ? this.terminalPinGcRange(partition, through)
      : this.gcRange(category, partition, through);
  }

  private async readGcDueCountInTxn(
    tn: Transaction,
    category: MigrationGcCategory,
    partition: number,
    through: number,
  ): Promise<number> {
    let node = BigInt(through) + 1n;
    const keys: Buffer[] = [];
    while (node > 0n) {
      keys.push(this.gcDueCountKey(category, partition, node));
      node -= node & -node;
    }
    const values = await Promise.all(keys.map(key => tn.snapshot().get(key)));
    let total = 0;
    for (let index = 0; index < values.length; index++) {
      const value = decodeCounter(
        values[index],
        `GC ${category} due counter partition ${partition} node ${keys[index].toString("hex")}`,
      );
      total += value;
      if (!Number.isSafeInteger(total)) {
        throw new MigrationCorruptionError(
          `GC ${category} due counter partition ${partition}`,
          "count exceeds safe integer range",
        );
      }
    }
    return total;
  }

  /** Exact, bounded GC observability: counts use Fenwick point reads
   * and oldest timestamps use one limit-1 read from each of 32 partitions. */
  public async inspectGcBacklog(
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<Record<MigrationGcCategory, MigrationGcBacklog>> {
    if (!isNonnegativeInteger(now)) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "GC observation time must be a nonnegative safe integer",
      );
    }
    if (signal?.aborted) throw signal.reason ?? new Error("GC aborted");
    const categories: MigrationGcCategory[] = ["pin", "control", "generation"];
    return await this.db.doTn(async tn => {
      this.configureGcTransaction(tn);
      if (signal?.aborted) throw signal.reason ?? new Error("GC aborted");
      const snapshots = await Promise.all(
        categories.map(async category => {
          const partitions = await Promise.all(
            Array.from(
              { length: MIGRATION_GC_PARTITIONS },
              async (_, partition) => {
                const range = this.gcCategoryRange(
                  category,
                  partition,
                  now + 1,
                );
                const [due, oldest] = await Promise.all([
                  this.readGcDueCountInTxn(tn, category, partition, now),
                  tn
                    .snapshot()
                    .getRangeAll(range.begin, range.end, { limit: 1 }),
                ]);
                const oldestDueAt = oldest[0]
                  ? Number(getFdb().tuple.unpack(oldest[0][0] as Buffer)[5])
                  : null;
                if (
                  oldestDueAt !== null &&
                  !isNonnegativeInteger(oldestDueAt)
                ) {
                  throw new MigrationCorruptionError(
                    `GC ${category} index partition ${partition}`,
                    "invalid due timestamp",
                  );
                }
                return { due, oldestDueAt };
              },
            ),
          );
          const due = partitions.reduce((sum, item) => sum + item.due, 0);
          if (!Number.isSafeInteger(due)) {
            throw new MigrationCorruptionError(
              `GC ${category} due counters`,
              "count exceeds safe integer range",
            );
          }
          const oldestDueAt = partitions.reduce<number | null>(
            (oldest, item) =>
              item.oldestDueAt !== null &&
              (oldest === null || item.oldestDueAt < oldest)
                ? item.oldestDueAt
                : oldest,
            null,
          );
          if ((due === 0) !== (oldestDueAt === null)) {
            throw new MigrationCorruptionError(
              `GC ${category} accounting`,
              `due count ${due} disagrees with due index`,
            );
          }
          return [
            category,
            {
              due,
              oldestDueAt,
              oldestOverdueMs:
                oldestDueAt === null ? 0 : Math.max(0, now - oldestDueAt),
            },
          ] as const;
        }),
      );
      return Object.fromEntries(snapshots) as Record<
        MigrationGcCategory,
        MigrationGcBacklog
      >;
    });
  }

  private configureGcTransaction(tn: Transaction): void {
    tn.setOption(
      TransactionOptionCode.Timeout,
      MIGRATION_GC_TRANSACTION_TIMEOUT_MS,
    );
  }

  private async claimGcPartition(
    category: string,
  ): Promise<{ partition: number; token: string } | null> {
    const token = randomUUID();
    return await this.db.doTn(async tn => {
      this.configureGcTransaction(tn);
      // This closure may start or retry long after the sweep's index cutoff was
      // captured. Lease eligibility must use the current attempt's wall clock,
      // not that stale cutoff, or delayed claimants can skip an expired shard
      // and advance the cursor past it.
      const leaseNow = Date.now();
      const cursorKey = this.gcCursorKey(category);
      const cursor = Number(
        parseJson(await tn.get(cursorKey), `GC ${category} cursor`) ?? 0,
      );
      if (!isNonnegativeInteger(cursor) || cursor >= MIGRATION_GC_PARTITIONS) {
        throw new MigrationCorruptionError(
          `GC ${category} cursor`,
          "invalid partition",
        );
      }

      // Read one complete, bounded rotation before choosing. Besides preserving
      // the conflict reads used by ordinary claims, this lets a doTn closure
      // replay after commit_unknown_result find the lease committed by its
      // first attempt instead of treating it as busy and advancing again.
      const leases: Array<{
        partition: number;
        key: Buffer;
        lease: { token: string; expiresAt: number } | null;
      }> = [];
      for (let offset = 0; offset < MIGRATION_GC_PARTITIONS; offset++) {
        const partition = (cursor + offset) % MIGRATION_GC_PARTITIONS;
        const key = this.gcLeaseKey(category, partition);
        const value = parseJson(await tn.get(key), `GC ${category} lease`) as {
          token?: unknown;
          expiresAt?: unknown;
        } | null;
        if (
          value &&
          (typeof value.token !== "string" ||
            value.token.length === 0 ||
            !isNonnegativeInteger(value.expiresAt))
        ) {
          throw new MigrationCorruptionError(
            `GC ${category} lease`,
            "invalid lease fields",
          );
        }
        leases.push({
          partition,
          key,
          lease: value
            ? {
                token: value.token as string,
                expiresAt: value.expiresAt as number,
              }
            : null,
        });
      }

      const ownLeases = leases.filter(item => item.lease?.token === token);
      if (ownLeases.length > 0) {
        // A successful claim leaves the cursor immediately after its partition.
        // Prefer that lease when repairing duplicates left by older buggy
        // commit-unknown replays; otherwise cursor order is deterministic.
        const committedPartition =
          (cursor + MIGRATION_GC_PARTITIONS - 1) % MIGRATION_GC_PARTITIONS;
        const keeper =
          ownLeases.find(item => item.partition === committedPartition) ??
          ownLeases[0];
        for (const duplicate of ownLeases) {
          if (duplicate.partition !== keeper.partition) tn.clear(duplicate.key);
        }
        // The same invocation may replay after its local lease deadline. The
        // key still names it, so no replacement won that partition and renewal
        // is safe. Deliberately do not move the already-committed cursor.
        tn.set(
          keeper.key,
          encodeJson({ token, expiresAt: leaseNow + MIGRATION_GC_LEASE_MS }),
        );
        return { partition: keeper.partition, token };
      }

      // Advancing once per unavailable partition let racing callers consume a
      // complete cursor rotation while old owners were still finishing empty
      // shards. Only a successful new claim advances the cursor.
      const available = leases.find(
        item => !item.lease || item.lease.expiresAt <= leaseNow,
      );
      if (!available) return null;
      tn.set(
        available.key,
        encodeJson({ token, expiresAt: leaseNow + MIGRATION_GC_LEASE_MS }),
      );
      tn.set(
        cursorKey,
        encodeJson((available.partition + 1) % MIGRATION_GC_PARTITIONS),
      );
      return { partition: available.partition, token };
    });
  }

  private async assertGcLeaseInTxn(
    tn: Transaction,
    category: string,
    partition: number,
    token: string,
    now: number,
  ): Promise<void> {
    const lease = parseJson(
      await tn.get(this.gcLeaseKey(category, partition)),
      `GC ${category} lease`,
    ) as { token?: unknown; expiresAt?: unknown } | null;
    if (
      lease?.token !== token ||
      !isNonnegativeInteger(lease.expiresAt) ||
      (lease.expiresAt as number) <= now
    ) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_GC_LEASE_LOST",
        `GC ${category} partition ${partition} lease lost`,
      );
    }
  }

  private async renewGcPartition(
    category: string,
    partition: number,
    token: string,
    now: number,
  ): Promise<boolean> {
    return await this.db.doTn(async tn => {
      this.configureGcTransaction(tn);
      try {
        await this.assertGcLeaseInTxn(tn, category, partition, token, now);
      } catch (error) {
        if (
          error instanceof MigrationStoreError &&
          error.code === "NUQ_MIGRATION_GC_LEASE_LOST"
        ) {
          return false;
        }
        throw error;
      }
      tn.set(
        this.gcLeaseKey(category, partition),
        encodeJson({ token, expiresAt: now + MIGRATION_GC_LEASE_MS }),
      );
      return true;
    });
  }

  private async releaseGcPartition(
    category: string,
    partition: number,
    token: string,
  ): Promise<void> {
    await this.db.doTn(async tn => {
      this.configureGcTransaction(tn);
      const key = this.gcLeaseKey(category, partition);
      const lease = parseJson(await tn.get(key), `GC ${category} lease`) as {
        token?: unknown;
      } | null;
      if (lease?.token === token) tn.clear(key);
    });
  }

  /**
   * Process one durably selected shard and at most one bounded page. PG is
   * probed first; deletion then re-reads the pin and every FDB canonical key in
   * one conflict-safe transaction. A missing Redis hint is intentionally not
   * an input to this decision.
   */
  public async sweepTerminalPins(
    authority: MigrationGcAuthority,
    options: {
      now?: number;
      limit?: number;
      recheckMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MigrationGcSweepResult | null> {
    const now = options.now ?? Date.now();
    const limit = options.limit ?? MIGRATION_GC_PAGE_LIMIT;
    const recheckMs = options.recheckMs ?? MIGRATION_GC_RECHECK_MS;
    if (!isPositiveInteger(limit) || limit > MIGRATION_GC_PAGE_LIMIT) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        `GC page limit must be between 1 and ${MIGRATION_GC_PAGE_LIMIT}`,
      );
    }
    if (!isPositiveInteger(recheckMs)) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "GC recheck must be a positive safe integer",
      );
    }
    const claim = await this.claimGcPartition("pin");
    if (!claim) return null;
    const result: MigrationGcSweepResult = {
      partition: claim.partition,
      read: 0,
      removed: 0,
      retained: 0,
      stale: 0,
      hasMore: false,
    };
    try {
      const range = this.terminalPinGcRange(claim.partition, now + 1);
      const rows = (await this.db.doTn(async tn => {
        this.configureGcTransaction(tn);
        await this.assertGcLeaseInTxn(
          tn,
          "pin",
          claim.partition,
          claim.token,
          Date.now(),
        );
        return await tn.snapshot().getRangeAll(range.begin, range.end, {
          limit,
        });
      })) as [Buffer, Buffer][];
      result.hasMore = rows.length === limit;
      for (const [indexKey] of rows) {
        if (options.signal?.aborted) {
          result.hasMore = true;
          break;
        }
        if (
          !(await this.renewGcPartition(
            "pin",
            claim.partition,
            claim.token,
            Date.now(),
          ))
        ) {
          result.hasMore = true;
          break;
        }
        result.read++;
        const parts = getFdb().tuple.unpack(indexKey);
        const dueAt = Number(parts[5]);
        const kind = String(parts[6]) as MigrationObjectKind;
        const objectId = String(parts[7]);
        const generation = Number(parts[8]);
        const terminalVersion = Number(parts[9]);
        const terminalAt = Number(parts[10]);
        if (
          !isNonnegativeInteger(dueAt) ||
          !OBJECT_KINDS.includes(kind) ||
          !isPositiveInteger(generation) ||
          !isPositiveInteger(terminalVersion) ||
          !isNonnegativeInteger(terminalAt)
        ) {
          throw new MigrationCorruptionError(
            "terminal pin GC index",
            "invalid identity",
          );
        }
        const observed = await this.inspectPin(kind, objectId);
        const matches =
          observed?.lifecycle === "terminal" &&
          observed.generation === generation &&
          observed.terminalVersion === terminalVersion &&
          observed.terminalAt === terminalAt;
        if (!matches) {
          const cleared = await this.db.doTn(async tn => {
            this.configureGcTransaction(tn);
            await this.assertGcLeaseInTxn(
              tn,
              "pin",
              claim.partition,
              claim.token,
              Date.now(),
            );
            const current = await this.inspectPinInTxn(tn, kind, objectId);
            if (
              current?.lifecycle === "terminal" &&
              current.generation === generation &&
              current.terminalVersion === terminalVersion &&
              current.terminalAt === terminalAt
            ) {
              return false;
            }
            // The canonical read conflicts with a concurrent replacement before
            // this index/accounting pair is cleared.
            return await this.clearGcIndexInTxn(
              tn,
              "pin",
              claim.partition,
              dueAt,
              indexKey,
            );
          });
          if (cleared) result.stale++;
          else result.retained++;
          continue;
        }

        const pgExists =
          observed.backend === "pg"
            ? await withGcDeadline(
                authority.pgObjectExists(observed, options.signal),
                options.signal,
              )
            : false;
        if (options.signal?.aborted) {
          result.hasMore = true;
          break;
        }
        const outcome = await this.db.doTn(async tn => {
          this.configureGcTransaction(tn);
          await this.assertGcLeaseInTxn(
            tn,
            "pin",
            claim.partition,
            claim.token,
            Date.now(),
          );
          const current = await this.inspectPinInTxn(tn, kind, objectId);
          if (
            !current ||
            current.lifecycle !== "terminal" ||
            current.generation !== generation ||
            current.terminalVersion !== terminalVersion ||
            current.terminalAt !== terminalAt
          ) {
            await this.clearGcIndexInTxn(
              tn,
              "pin",
              claim.partition,
              dueAt,
              indexKey,
            );
            return "stale" as const;
          }
          const teamIndex = await tn.get(
            this.teamObjectKey(current.teamId, current.kind, current.objectId),
          );
          const hasFdbReference = await authority.fdbReferenceExistsInTxn(
            tn,
            current,
          );
          const operationRange = this.legacyObjectOperationRange(
            current.teamId,
            current.kind,
            current.objectId,
          );
          const operationRows = await tn.getRangeAll(
            operationRange.begin as Buffer,
            operationRange.end as Buffer,
            { limit: MIGRATION_GC_PAGE_LIMIT },
          );
          if (
            pgExists ||
            hasFdbReference ||
            teamIndex ||
            Object.values(current.residue).some(value => value !== 0)
          ) {
            await this.clearGcIndexInTxn(
              tn,
              "pin",
              claim.partition,
              dueAt,
              indexKey,
            );
            await this.setGcIndexInTxn(
              tn,
              "pin",
              claim.partition,
              now + recheckMs,
              this.terminalPinGcKey(current, now + recheckMs),
            );
            return "retained" as const;
          }
          // Prototype operation ledgers are boundedly compacted only after the
          // pin's full retention window. Delete the pin in the same commit only
          // when no operation token remains to reference it.
          for (const [operationKey] of operationRows) {
            tn.clear(operationKey as Buffer);
          }
          if (operationRows.length === MIGRATION_GC_PAGE_LIMIT) {
            await this.clearGcIndexInTxn(
              tn,
              "pin",
              claim.partition,
              dueAt,
              indexKey,
            );
            await this.setGcIndexInTxn(
              tn,
              "pin",
              claim.partition,
              now + recheckMs,
              this.terminalPinGcKey(current, now + recheckMs),
            );
            return "retained" as const;
          }
          tn.clear(this.objectKey(kind, objectId));
          tn.clear(this.generationObjectKey(current));
          await this.clearGcIndexInTxn(
            tn,
            "pin",
            claim.partition,
            dueAt,
            indexKey,
          );
          return "removed" as const;
        });
        result[outcome]++;
      }
      return result;
    } finally {
      await this.releaseGcPartition("pin", claim.partition, claim.token);
    }
  }

  public async sweepControlHistory(
    options: {
      now?: number;
      limit?: number;
      recheckMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MigrationGcSweepResult | null> {
    const now = options.now ?? Date.now();
    const limit = options.limit ?? MIGRATION_GC_PAGE_LIMIT;
    const recheckMs = options.recheckMs ?? MIGRATION_GC_RECHECK_MS;
    if (!isPositiveInteger(limit) || limit > MIGRATION_GC_PAGE_LIMIT) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        `GC page limit must be between 1 and ${MIGRATION_GC_PAGE_LIMIT}`,
      );
    }
    if (!isPositiveInteger(recheckMs)) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "GC recheck must be a positive safe integer",
      );
    }
    const claim = await this.claimGcPartition("control");
    if (!claim) return null;
    const result: MigrationGcSweepResult = {
      partition: claim.partition,
      read: 0,
      removed: 0,
      retained: 0,
      stale: 0,
      hasMore: false,
    };
    try {
      const range = this.gcRange("control", claim.partition, now + 1);
      const rows = (await this.db.doTn(async tn => {
        this.configureGcTransaction(tn);
        await this.assertGcLeaseInTxn(
          tn,
          "control",
          claim.partition,
          claim.token,
          Date.now(),
        );
        return await tn.snapshot().getRangeAll(range.begin, range.end, {
          limit,
        });
      })) as [Buffer, Buffer][];
      result.hasMore = rows.length === limit;
      for (const [indexKey] of rows) {
        if (options.signal?.aborted) {
          result.hasMore = true;
          break;
        }
        if (
          !(await this.renewGcPartition(
            "control",
            claim.partition,
            claim.token,
            Date.now(),
          ))
        ) {
          result.hasMore = true;
          break;
        }
        result.read++;
        const parts = getFdb().tuple.unpack(indexKey);
        const dueAt = Number(parts[5]);
        const teamId = String(parts[6]);
        const operationId = String(parts[7]);
        const version = Number(parts[8]);
        const terminalAt = Number(parts[9]);
        if (
          !isNonnegativeInteger(dueAt) ||
          teamId.length === 0 ||
          operationId.length === 0 ||
          !isPositiveInteger(version) ||
          !isNonnegativeInteger(terminalAt)
        ) {
          throw new MigrationCorruptionError(
            "control history GC index",
            "invalid identity",
          );
        }
        const outcome = await this.db.doTn(async tn => {
          this.configureGcTransaction(tn);
          await this.assertGcLeaseInTxn(
            tn,
            "control",
            claim.partition,
            claim.token,
            Date.now(),
          );
          const raw = await tn.get(
            this.controlOperationKey(teamId, operationId),
          );
          if (!raw) {
            await this.clearGcIndexInTxn(
              tn,
              "control",
              claim.partition,
              dueAt,
              indexKey,
            );
            return "stale" as const;
          }
          const operation = validateControlOperation(
            parseJson(raw, `control operation ${operationId}`),
            `control operation ${operationId}`,
          );
          if (
            operation.terminalVersion !== version ||
            operation.terminalAt !== terminalAt ||
            operation.outcome === "pending"
          ) {
            await this.clearGcIndexInTxn(
              tn,
              "control",
              claim.partition,
              dueAt,
              indexKey,
            );
            return "stale" as const;
          }
          const state = await this.readState(tn, teamId);
          if (state?.transitionOperationId === operationId) {
            await this.clearGcIndexInTxn(
              tn,
              "control",
              claim.partition,
              dueAt,
              indexKey,
            );
            await this.setGcIndexInTxn(
              tn,
              "control",
              claim.partition,
              now + recheckMs,
              this.controlGcKey(teamId, operation, now + recheckMs),
            );
            return "retained" as const;
          }
          tn.clear(this.controlOperationKey(teamId, operationId));
          for (const generation of this.controlReferencedGenerations(
            operation,
          )) {
            tn.clear(
              this.controlGenerationRefKey(teamId, generation, operationId),
            );
          }
          await this.clearGcIndexInTxn(
            tn,
            "control",
            claim.partition,
            dueAt,
            indexKey,
          );
          return "removed" as const;
        });
        result[outcome]++;
      }
      return result;
    } finally {
      await this.releaseGcPartition("control", claim.partition, claim.token);
    }
  }

  public async sweepClosedGenerations(
    options: {
      now?: number;
      limit?: number;
      recheckMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MigrationGcSweepResult | null> {
    const now = options.now ?? Date.now();
    const limit = options.limit ?? MIGRATION_GC_PAGE_LIMIT;
    const recheckMs = options.recheckMs ?? MIGRATION_GC_RECHECK_MS;
    if (!isPositiveInteger(limit) || limit > MIGRATION_GC_PAGE_LIMIT) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        `GC page limit must be between 1 and ${MIGRATION_GC_PAGE_LIMIT}`,
      );
    }
    if (!isPositiveInteger(recheckMs)) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "GC recheck must be a positive safe integer",
      );
    }
    const claim = await this.claimGcPartition("generation");
    if (!claim) return null;
    const result: MigrationGcSweepResult = {
      partition: claim.partition,
      read: 0,
      removed: 0,
      retained: 0,
      stale: 0,
      hasMore: false,
    };
    try {
      const range = this.gcRange("generation", claim.partition, now + 1);
      const rows = (await this.db.doTn(async tn => {
        this.configureGcTransaction(tn);
        await this.assertGcLeaseInTxn(
          tn,
          "generation",
          claim.partition,
          claim.token,
          Date.now(),
        );
        return await tn.snapshot().getRangeAll(range.begin, range.end, {
          limit,
        });
      })) as [Buffer, Buffer][];
      result.hasMore = rows.length === limit;
      for (const [indexKey] of rows) {
        if (options.signal?.aborted) {
          result.hasMore = true;
          break;
        }
        if (
          !(await this.renewGcPartition(
            "generation",
            claim.partition,
            claim.token,
            Date.now(),
          ))
        ) {
          result.hasMore = true;
          break;
        }
        result.read++;
        const parts = getFdb().tuple.unpack(indexKey);
        const dueAt = Number(parts[5]);
        const teamId = String(parts[6]);
        const generationNumber = Number(parts[7]);
        const version = Number(parts[8]);
        const terminalAt = Number(parts[9]);
        if (
          !isNonnegativeInteger(dueAt) ||
          teamId.length === 0 ||
          !isPositiveInteger(generationNumber) ||
          !isPositiveInteger(version) ||
          !isNonnegativeInteger(terminalAt)
        ) {
          throw new MigrationCorruptionError(
            "closed generation GC index",
            "invalid identity",
          );
        }
        const outcome = await this.db.doTn(async tn => {
          this.configureGcTransaction(tn);
          await this.assertGcLeaseInTxn(
            tn,
            "generation",
            claim.partition,
            claim.token,
            Date.now(),
          );
          const generation = await this.readGeneration(
            tn,
            teamId,
            generationNumber,
          );
          if (
            !generation ||
            generation.status !== "closed" ||
            generation.gcIndexed !== true ||
            generation.terminalVersion !== version ||
            generation.terminalAt !== terminalAt
          ) {
            await this.clearGcIndexInTxn(
              tn,
              "generation",
              claim.partition,
              dueAt,
              indexKey,
            );
            return "stale" as const;
          }
          const state = await this.readState(tn, teamId);
          const residue = await this.readResidue(tn, teamId, generationNumber);
          const objectRange = this.generationObjectRange(
            teamId,
            generationNumber,
          );
          const controlRange = this.controlGenerationRefRange(
            teamId,
            generationNumber,
          );
          const [objects, controls] = await Promise.all([
            tn.getRangeAll(
              objectRange.begin as Buffer,
              objectRange.end as Buffer,
              {
                limit: 1,
              },
            ),
            tn.getRangeAll(
              controlRange.begin as Buffer,
              controlRange.end as Buffer,
              {
                limit: 1,
              },
            ),
          ]);
          if (
            state?.activeGeneration === generationNumber ||
            state?.targetGeneration === generationNumber ||
            Object.values(residue).some(value => value !== 0) ||
            objects.length > 0 ||
            controls.length > 0
          ) {
            await this.clearGcIndexInTxn(
              tn,
              "generation",
              claim.partition,
              dueAt,
              indexKey,
            );
            await this.setGcIndexInTxn(
              tn,
              "generation",
              claim.partition,
              now + recheckMs,
              this.generationGcKey(generation, now + recheckMs),
            );
            return "retained" as const;
          }
          tn.clear(this.generationKey(teamId, generationNumber));
          for (const counter of MIGRATION_RESIDUE_COUNTERS) {
            tn.clear(this.residueKey(teamId, generationNumber, counter));
          }
          await this.clearGcIndexInTxn(
            tn,
            "generation",
            claim.partition,
            dueAt,
            indexKey,
          );
          return "removed" as const;
        });
        result[outcome]++;
      }
      return result;
    } finally {
      await this.releaseGcPartition("generation", claim.partition, claim.token);
    }
  }

  public async finalSeal(input: {
    teamId: string;
    transitionOperationId: string;
    expectedRevision?: number;
  }): Promise<MigrationTeamState> {
    const { teamId, transitionOperationId, expectedRevision } = input;
    assertNonempty(teamId, "teamId");
    assertNonempty(transitionOperationId, "transitionOperationId");
    return await this.db.doTn(async tn => {
      await this.assertCoreReadinessInTxn(tn);
      const opKey = this.controlOperationKey(teamId, transitionOperationId);
      const rawOp = await tn.get(opKey);
      if (!rawOp) {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      const op = validateControlOperation(
        parseJson(rawOp, `control operation ${transitionOperationId}`),
        `control operation ${transitionOperationId}`,
      );
      if (
        op.operationId !== transitionOperationId ||
        op.state.teamId !== teamId
      ) {
        throw new MigrationCorruptionError(
          `control operation ${transitionOperationId}`,
          "identity mismatch",
        );
      }
      if (op.kind !== "begin") {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      if (op.outcome === "completed") return op.state;
      if (op.outcome === "cancelled") {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_TRANSITION_CANCELLED",
          `transition ${transitionOperationId} was cancelled`,
        );
      }
      const state = await this.readState(tn, teamId);
      if (!state) throw new MigrationLegacyStateError(teamId);
      if (
        expectedRevision !== undefined &&
        state.revision !== expectedRevision
      ) {
        throw new MigrationCasError(expectedRevision, state.revision);
      }
      if (state.transitionOperationId !== transitionOperationId) {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      const source = await this.requireGeneration(
        tn,
        teamId,
        state.activeGeneration,
      );
      const target = await this.requireGeneration(
        tn,
        teamId,
        state.targetGeneration!,
      );
      if (
        source.status !== "draining" ||
        source.backend !== state.activeBackend ||
        target.status !== "closed" ||
        target.backend !== state.targetBackend
      ) {
        throw new MigrationCorruptionError(
          `team ${teamId}`,
          "transition generation state mismatch",
        );
      }
      const sourceResidue = await this.readResidue(
        tn,
        teamId,
        source.generation,
      );
      if (Object.values(sourceResidue).some(value => value !== 0)) {
        throw new MigrationResidueNotEmptyError(
          teamId,
          source.generation,
          sourceResidue,
        );
      }
      const targetResidue = await this.readResidue(
        tn,
        teamId,
        target.generation,
      );
      if (Object.values(targetResidue).some(value => value !== 0)) {
        throw new MigrationCorruptionError(
          `team ${teamId} generation ${target.generation}`,
          "closed target has residue",
        );
      }
      const next: MigrationTeamState = {
        schemaVersion: 1,
        teamId,
        revision: nextRevision(state),
        maxGeneration: state.maxGeneration,
        activeBackend: target.backend,
        activeGeneration: target.generation,
        phase: stablePhase(target.backend),
      };
      const closedSource: MigrationGeneration = {
        ...source,
        status: "closed",
        ...(source.gcIndexed
          ? { terminalAt: Date.now(), terminalVersion: next.revision }
          : {}),
      };
      const openTarget: MigrationGeneration = {
        ...target,
        status: "open",
        terminalAt: undefined,
        terminalVersion: undefined,
      };
      const completedOp: ControlOperation = {
        ...op,
        outcome: "completed",
        state: next,
        terminalAt: Date.now(),
        terminalVersion: next.revision,
      };
      await this.writeGenerationInTxn(tn, source, closedSource);
      await this.writeGenerationInTxn(tn, target, openTarget);
      tn.set(this.teamStateKey(teamId), encodeJson(next));
      await this.writeControlOperationInTxn(tn, teamId, op, completedOp);
      return next;
    });
  }
}

export const nuqFdbMigrationStore = new NuqFdbMigrationStore(true);
