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
};

/**
 * Outcome of an Autumn credit lock attempt.
 *
 * - `denied`: Autumn refused (`allowed: false`); the caller must NOT proceed.
 * - `skipped`: billing not in effect (no client, preview team, or API fallback);
 *   the caller should proceed without a lock.
 * - `locked`: reserved; `lockId` must be finalized later.
 */
export type LockCreditsResult =
  | { status: "locked"; lockId: string }
  | { status: "denied" }
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
