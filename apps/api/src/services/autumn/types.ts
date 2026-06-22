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
};

export type TrackCreditsParams = {
  teamId: string;
  value: number;
  properties?: Record<string, unknown>;
  featureId?: string;
};

export type CreateEntityResult =
  | { ok: true; entity: unknown }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false };
