import { randomUUID } from "crypto";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { supabase_rr_service } from "../supabase";
import { autumnClient } from "./client";
import type {
  CreateEntityParams,
  CreateEntityResult,
  EnsureOrgProvisionedParams,
  EnsureTeamProvisionedParams,
  FinalizeCreditsLockParams,
  GetEntityParams,
  GetOrCreateCustomerParams,
  LockCreditsParams,
  TrackCreditsParams,
  TrackParams,
} from "./types";

const TEAM_FEATURE_ID = "TEAM";
const CREDITS_FEATURE_ID = "CREDITS";

/**
 * Returns true when the Autumn experiment is active.
 *
 * Only checked at the top-level billing entry points (`lockCredits` and the
 * direct-track `trackCredits`).
 * NOT checked by `finalizeCreditsLock`, `refundCredits`, or
 * `ensureTeamProvisioned`.
 */
export function isAutumnEnabled(): boolean {
  return config.AUTUMN_EXPERIMENT === "true";
}

export function isAutumnCheckEnabled(): boolean {
  return (
    config.AUTUMN_CHECK_ENABLED === "true" &&
    config.AUTUMN_EXPERIMENT === "true"
  );
}

/**
 * When true, Autumn check results are logged but never used to gate requests.
 * The legacy credit system remains authoritative.
 */
export function isAutumnCheckDryRun(): boolean {
  return config.AUTUMN_CHECK_DRY_RUN === "true";
}

const AUTUMN_DEFAULT_PLAN_ID = "free";
/**
 * Size-bounded Map with FIFO eviction. When the map is at capacity the oldest
 * inserted entry is removed before inserting the new one, keeping memory usage
 * at most O(max) regardless of how many unique keys are seen over time.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super();
  }

  set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.max) {
      this.delete(this.keys().next().value as K);
    }
    return super.set(key, value);
  }
}

/**
 * Size-bounded Set with FIFO eviction. Mirrors BoundedMap for set semantics.
 */
export class BoundedSet<V> extends Set<V> {
  constructor(private readonly max: number) {
    super();
  }

  add(value: V): this {
    if (!this.has(value) && this.size >= this.max) {
      this.delete(this.values().next().value as V);
    }
    return super.add(value);
  }
}

/**
 * Wraps Autumn customer/entity provisioning and usage tracking for team credit billing.
 */
export class AutumnService {
  private customerOrgCache = new BoundedMap<string, string>(50_000);
  private ensuredOrgs = new BoundedSet<string>(50_000);
  private ensuredTeams = new BoundedSet<string>(50_000);

  private isPreviewTeam(teamId: string): boolean {
    return teamId === "preview" || teamId.startsWith("preview_");
  }

  private async lookupOrgIdForTeam(teamId: string): Promise<string> {
    const { data, error } = await supabase_rr_service
      .from("teams")
      .select("org_id")
      .eq("id", teamId)
      .single();

    if (error) throw error;
    if (!data?.org_id) {
      throw new Error(`Missing org_id for team ${teamId}`);
    }

    return data.org_id;
  }

  private getErrorStatus(error: unknown): number | undefined {
    const status = (error as any)?.statusCode ?? (error as any)?.status;
    if (typeof status === "number") return status;
    const responseStatus = (error as any)?.response?.status;
    return typeof responseStatus === "number" ? responseStatus : undefined;
  }

  private async getOrCreateCustomer({
    customerId,
    name,
    email,
    autoEnablePlanId = AUTUMN_DEFAULT_PLAN_ID,
  }: GetOrCreateCustomerParams): Promise<unknown | null> {
    if (!autumnClient) return null;
    if (!customerId) return null;

    try {
      const customer = await autumnClient.customers.getOrCreate({
        customerId,
        name: name ?? undefined,
        email: email ?? undefined,
        autoEnablePlanId,
      });
      logger.info("Autumn getOrCreateCustomer succeeded", { customerId });
      return customer;
    } catch (error) {
      logger.error(
        "Autumn getOrCreateCustomer failed — billing API may be unavailable",
        { customerId, error },
      );
      return null;
    }
  }

  private async getEntity({
    customerId,
    entityId,
  }: GetEntityParams): Promise<unknown | null> {
    if (!autumnClient) return null;

    try {
      return await autumnClient.entities.get({ customerId, entityId });
    } catch (error) {
      const status = this.getErrorStatus(error);
      if (status === 404) {
        return null;
      }

      logger.error("Autumn getEntity failed — billing API may be unavailable", {
        customerId,
        entityId,
        error,
      });
      return null;
    }
  }

  private async createEntity({
    customerId,
    entityId,
    featureId,
    name,
  }: CreateEntityParams): Promise<CreateEntityResult> {
    if (!autumnClient) return { ok: false, conflict: false };

    try {
      const entity = await autumnClient.entities.create({
        customerId,
        entityId,
        featureId,
        name: name ?? undefined,
      });
      logger.info("Autumn createEntity succeeded", {
        customerId,
        entityId,
        featureId,
      });
      return { ok: true, entity };
    } catch (error) {
      const status = this.getErrorStatus(error);
      if (status === 409) {
        // Entity already exists — treat as success for provisioning purposes.
        return { ok: false, conflict: true };
      }

      logger.error(
        "Autumn createEntity failed — billing API may be unavailable",
        {
          customerId,
          entityId,
          featureId,
          error,
        },
      );
      return { ok: false, conflict: false };
    }
  }

  private async track({
    customerId,
    entityId,
    featureId,
    value,
    properties,
  }: TrackParams): Promise<boolean> {
    if (!autumnClient) return false;

    try {
      await autumnClient.track({
        customerId,
        entityId,
        featureId,
        value,
        properties,
      });
      logger.info("Autumn track succeeded", {
        customerId,
        entityId,
        featureId,
        value,
      });
      return true;
    } catch (error) {
      logger.error("Autumn track failed — billing API may be unavailable", {
        customerId,
        entityId,
        featureId,
        value,
        error,
      });
      return false;
    }
  }

  /**
   * Ensures the Autumn customer exists for an org, caching successful lookups in-process.
   */
  async ensureOrgProvisioned({
    orgId,
    name,
    email,
  }: EnsureOrgProvisionedParams): Promise<void> {
    if (this.ensuredOrgs.has(orgId)) return;
    const customer = await this.getOrCreateCustomer({
      customerId: orgId,
      name,
      email,
    });
    if (customer) {
      this.ensuredOrgs.add(orgId);
    }
  }

  /**
   * Ensures the Autumn entity exists for a team under its org customer.
   *
   * The `ensuredTeams` check is performed first so that already-provisioned
   * teams incur no HTTP calls — not even the `ensureOrgProvisioned` round-trip.
   */
  async ensureTeamProvisioned({
    teamId,
    orgId,
    name,
  }: EnsureTeamProvisionedParams): Promise<void> {
    if (!autumnClient) return;
    if (this.isPreviewTeam(teamId)) return;
    // Fast path: team is already fully provisioned.
    if (this.ensuredTeams.has(teamId)) return;

    try {
      const resolvedOrgId = orgId ?? (await this.lookupOrgIdForTeam(teamId));
      this.customerOrgCache.set(teamId, resolvedOrgId);
      await this.ensureOrgProvisioned({ orgId: resolvedOrgId });

      const entity = await this.getEntity({
        customerId: resolvedOrgId,
        entityId: teamId,
      });

      if (!entity) {
        const result = await this.createEntity({
          customerId: resolvedOrgId,
          entityId: teamId,
          featureId: TEAM_FEATURE_ID,
          name,
        });
        if (result.ok || ("conflict" in result && result.conflict)) {
          // Entity was just created, or already existed (409 race) — either way
          // it's present. No need for a second getEntity confirmation call.
          this.ensuredTeams.add(teamId);
        }
        // Genuine error: leave ensuredTeams empty so the next request retries.
        return;
      }

      this.ensuredTeams.add(teamId);
    } catch (error) {
      logger.error(
        "Autumn ensureTeamProvisioned failed — billing API may be unavailable",
        { teamId, error },
      );
    }
  }

  /**
   * Resolves the orgId for a team, returning the cached value when available
   * and populating the cache on miss.  Does NOT provision anything.
   */
  private async resolveOrgId(teamId: string): Promise<string> {
    const cached = this.customerOrgCache.get(teamId);
    if (cached) return cached;
    const orgId = await this.lookupOrgIdForTeam(teamId);
    this.customerOrgCache.set(teamId, orgId);
    return orgId;
  }

  /**
   * Resolves and warms the Autumn customer/entity context needed before tracking usage.
   *
   * When both caches are warm (orgId known + team fully provisioned) we return
   * immediately without calling ensureTeamProvisioned, avoiding redundant
   * map/set lookups on every billing operation.
   */
  private async ensureTrackingContext(teamId: string): Promise<string> {
    const orgId = await this.resolveOrgId(teamId);
    if (!this.ensuredTeams.has(teamId)) {
      await this.ensureTeamProvisioned({ teamId, orgId });
    }
    return orgId;
  }

  /**
   * Checks whether a team has enough Autumn balance to cover a request.
   * Returns null when Autumn gating is unavailable and callers should fall back.
   */
  async checkCredits({
    teamId,
    value,
    properties,
  }: TrackCreditsParams): Promise<{
    allowed: boolean;
    remaining: number;
  } | null> {
    if (!autumnClient || this.isPreviewTeam(teamId)) {
      return null;
    }
    try {
      if (!isAutumnCheckEnabled()) return null;

      const customerId = await this.ensureTrackingContext(teamId);
      const { allowed, balance } = await autumnClient.check({
        customerId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        requiredBalance: value,
        properties,
      });

      const remaining = balance?.remaining ?? 0;

      logger.debug("Autumn checkCredits completed", {
        customerId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        value,
        allowed,
        remaining,
      });
      return { allowed, remaining };
    } catch (error) {
      logger.error(
        "Autumn checkCredits failed — billing API may be unavailable, falling back",
        {
          teamId,
          value,
          error,
        },
      );
      return null;
    }
  }

  /**
   * Reserves a team's credits in Autumn without letting Autumn gate usage.
   * Returns the lock ID on success, or null if no lock was acquired.
   */
  async lockCredits({
    teamId,
    value,
    lockId,
    expiresAt,
    properties,
  }: LockCreditsParams): Promise<string | null> {
    if (!autumnClient || this.isPreviewTeam(teamId)) {
      return null;
    }
    const resolvedLockId = lockId ?? `billing_${randomUUID()}`;

    try {
      if (!isAutumnEnabled()) return null;

      const customerId = await this.ensureTrackingContext(teamId);
      const { allowed } = await autumnClient.check({
        customerId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        requiredBalance: value,
        properties,
        lock: {
          enabled: true,
          lockId: resolvedLockId,
          expiresAt,
        },
      });

      if (!allowed) {
        logger.info("Autumn lockCredits denied", {
          teamId,
          value,
          lockId: resolvedLockId,
        });
        return null;
      }

      logger.info("Autumn lockCredits succeeded", {
        customerId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        value,
        lockId: resolvedLockId,
        properties,
      });
      return resolvedLockId;
    } catch (error) {
      logger.error(
        "Autumn lockCredits failed — billing API may be unavailable, falling back",
        {
          teamId,
          value,
          lockId: resolvedLockId,
          error,
        },
      );
      return null;
    }
  }

  /**
   * Finalizes a previously-acquired Autumn lock.
   */
  async finalizeCreditsLock({
    lockId,
    action,
    overrideValue,
    properties,
  }: FinalizeCreditsLockParams): Promise<void> {
    if (!autumnClient) return;

    try {
      await autumnClient.balances.finalize({
        lockId,
        action,
        overrideValue,
        properties,
      });
      logger.info("Autumn finalizeCreditsLock succeeded", {
        lockId,
        action,
        overrideValue,
      });
    } catch (error) {
      logger.error(
        "Autumn finalizeCreditsLock failed — billing API may be unavailable",
        {
          lockId,
          action,
          overrideValue,
          error,
        },
      );
    }
  }

  /**
   * Records a credit usage event directly in Autumn. Returns true on success.
   */
  async trackCredits({
    teamId,
    value,
    properties,
  }: TrackCreditsParams): Promise<boolean> {
    if (!isAutumnEnabled()) return false;
    if (!autumnClient) return false;
    if (this.isPreviewTeam(teamId)) return false;

    try {
      const customerId = await this.ensureTrackingContext(teamId);
      return await this.track({
        customerId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        value,
        properties,
      });
    } catch (error) {
      logger.error(
        "Autumn trackCredits failed — billing API may be unavailable",
        {
          teamId,
          value,
          error,
        },
      );
      return false;
    }
  }

  /**
   * Reverses a prior trackCredits call by tracking a negative usage event.
   */
  async refundCredits({
    teamId,
    value,
    properties,
  }: TrackCreditsParams): Promise<void> {
    if (!autumnClient) return;
    if (this.isPreviewTeam(teamId)) return;

    try {
      const customerId = await this.ensureTrackingContext(teamId);
      await this.track({
        customerId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        value: -value,
        properties: { ...properties, source: "autumn_refund" },
      });
    } catch (error) {
      logger.error(
        "Autumn refundCredits failed — billing API may be unavailable",
        { teamId, value, error },
      );
    }
  }
}

export const autumnService = new AutumnService();
