export type GetOrCreateCustomerParams = {
  customerId: string;
  name?: string | null;
  email?: string | null;
  autoEnablePlanId?: string;
};

export type GetEntityParams = {
  customerId: string;
  entityId: string;
};

export type CreateEntityParams = {
  customerId: string;
  entityId: string;
  featureId: string;
  name?: string | null;
};

export type TrackParams = {
  customerId: string;
  entityId?: string;
  featureId: string;
  value: number;
  properties?: Record<string, unknown>;
  /**
   * Stable per-charge identity, honored on the firebill route only (the
   * direct Autumn SDK does not expose its Idempotency-Key header). When set,
   * a caller retry — or a requeued job re-billing the same work — dedupes
   * instead of double-billing. Must be unique per CHARGE, never a shared id
   * like a crawl id (every page shares it: collision = underbilling).
   */
  idempotencyKey?: string;
};

export type EnsureOrgProvisionedParams = {
  orgId: string;
  name?: string | null;
  email?: string | null;
};

export type EnsureTeamProvisionedParams = {
  teamId: string;
  orgId?: string | null;
  name?: string | null;
};

export type LockCreditsParams = {
  teamId: string;
  value: number;
  lockId?: string;
  expiresAt?: number;
  properties?: Record<string, unknown>;
  featureId?: string;
  /**
   * A gateway partner's opaque token for the recurring job this hold is one
   * occurrence of. Present is what arms the partner's own credit gate inside
   * firebill: it asks the partner whether they will fund this run *before*
   * Autumn is asked to hold anything, and only then takes the hold.
   *
   * Honoured on the firebill route only — but a partner-provisioned org always
   * routes there ({@link shouldRouteToFirebill}), so a token that matters is
   * never on the direct-Autumn path.
   */
  partnerJobToken?: string | null;
};

/**
 * Why a hold was refused, when a gateway partner's own gate is what refused it
 * rather than Autumn. Absent on an ordinary Autumn denial.
 *
 * `job_revoked` is the only one that never resolves on its own, and the only
 * one a caller may answer by stopping a schedule rather than waiting for the
 * next occurrence.
 */
export type LockDeniedReason =
  | "out_of_credits"
  | "job_revoked"
  | "gate_unavailable";

/**
 * Outcome of an Autumn credit lock attempt.
 *
 * - `denied`: Autumn refused (`allowed: false`), or a gateway partner's gate
 *   did — see `reason`; either way the caller must NOT proceed.
 * - `skipped`: billing not in effect (no client, preview team, or API fallback);
 *   the caller should proceed without a lock.
 * - `locked`: reserved; `lockId` must be finalized later. `operationToken` is
 *   the partner's own id for this occurrence, when a partner gate authorized
 *   it: hand it back on the finalize and the run is reported under it.
 */
export type LockCreditsResult =
  | { status: "locked"; lockId: string; operationToken?: string }
  | { status: "denied"; reason?: LockDeniedReason }
  | { status: "skipped" };

export type FinalizeCreditsLockParams = {
  lockId: string;
  action: "confirm" | "release";
  overrideValue?: number;
  properties?: Record<string, unknown>;
  /**
   * The team the lock was taken for. Needed to route the settle through
   * firebill for allowlisted orgs — a finalize carries no customer context of
   * its own. When omitted, the settle goes directly to Autumn (which also
   * works for a firebill-taken lock: the hold lives in Autumn either way, but
   * loses firebill's durable retry).
   */
  teamId?: string;
  /**
   * The partner's own id for the work being settled — for a gated run, the
   * `operationToken` its lock handed back. firebill carries it as the
   * operation id the charge is reported under. Ignored on the direct-Autumn
   * route, which reports to no partner.
   */
  externalRequestId?: string | null;
};

export type TrackCreditsParams = {
  teamId: string;
  value: number;
  properties?: Record<string, unknown>;
  featureId?: string;
  /** See TrackParams.idempotencyKey. */
  idempotencyKey?: string;
};

export type CreateEntityResult =
  | { ok: true; entity: unknown }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false };
