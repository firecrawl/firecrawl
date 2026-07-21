import { randomUUID } from "crypto";
import { logger } from "../../lib/logger";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { getRedisConnection } from "../queue-service";
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
  LockCreditsResult,
  TrackCreditsParams,
  TrackParams,
} from "./types";

export const TEAM_FEATURE_ID = "TEAM";
export const CREDITS_FEATURE_ID = "CREDITS";
export const SEARCH_CREDITS_FEATURE_ID = "SEARCH_CREDITS";

/**
 * Event property that identifies the API key (numeric api_keys.id). A per-key
 * credit limit is an Autumn usage limit on CREDITS whose filter matches this
 * property, and check/track send the same property so only that key's usage
 * counts toward the cap. Must stay in sync with the checkCredits/trackCredits
 * `properties.apiKeyId` payload.
 */
const API_KEY_CREDIT_LIMIT_PROPERTY = "apiKeyId";

/**
 * Maps a billing endpoint to the Autumn feature ID it should bill against.
 *
 * Search balance and usage are tracked against a dedicated SEARCH_CREDITS
 * feature; everything else uses the general CREDITS feature. Scrapes performed
 * as part of a search bill themselves under their own (non-search) endpoint, so
 * they correctly remain on CREDITS.
 */
export function featureIdForBillingEndpoint(endpoint?: string): string {
  return endpoint === "search" ? SEARCH_CREDITS_FEATURE_ID : CREDITS_FEATURE_ID;
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
    const [data] = await dbRr
      .select({ org_id: schema.teams.org_id })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId))
      .limit(1);

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
    featureId = CREDITS_FEATURE_ID,
  }: TrackCreditsParams): Promise<{
    allowed: boolean;
    remaining: number;
  } | null> {
    if (!autumnClient || this.isPreviewTeam(teamId)) {
      return null;
    }
    try {
      const customerId = await this.ensureTrackingContext(teamId);
      const { allowed, balance } = await autumnClient.check({
        customerId,
        entityId: teamId,
        featureId,
        requiredBalance: value,
        properties,
      });

      const remaining = balance?.remaining ?? 0;

      logger.debug("Autumn checkCredits completed", {
        customerId,
        entityId: teamId,
        featureId,
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
   * Attempts to reserve a team's credits in Autumn. See {@link LockCreditsResult}.
   */
  async lockCredits({
    teamId,
    value,
    lockId,
    expiresAt,
    properties,
    featureId = CREDITS_FEATURE_ID,
  }: LockCreditsParams): Promise<LockCreditsResult> {
    if (!autumnClient || this.isPreviewTeam(teamId)) {
      return { status: "skipped" };
    }
    const resolvedLockId = lockId ?? `billing_${randomUUID()}`;

    try {
      const customerId = await this.ensureTrackingContext(teamId);
      const { allowed } = await autumnClient.check({
        customerId,
        entityId: teamId,
        featureId,
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
        return { status: "denied" };
      }

      logger.info("Autumn lockCredits succeeded", {
        customerId,
        entityId: teamId,
        featureId,
        value,
        lockId: resolvedLockId,
        properties,
      });
      return { status: "locked", lockId: resolvedLockId };
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
      return { status: "skipped" };
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
    featureId = CREDITS_FEATURE_ID,
  }: TrackCreditsParams): Promise<boolean> {
    if (!autumnClient) return false;
    if (this.isPreviewTeam(teamId)) return false;

    try {
      const customerId = await this.ensureTrackingContext(teamId);
      return await this.track({
        customerId,
        entityId: teamId,
        featureId,
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
    featureId = CREDITS_FEATURE_ID,
  }: TrackCreditsParams): Promise<void> {
    if (!autumnClient) return;
    if (this.isPreviewTeam(teamId)) return;

    try {
      const customerId = await this.ensureTrackingContext(teamId);
      await this.track({
        customerId,
        entityId: teamId,
        featureId,
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

  /**
   * Runs `fn` while holding a short per-customer Redis lock, so concurrent
   * rebuilds of a customer's usage limits can't clobber each other. Retries
   * acquisition with a small backoff; returns null if the lock can't be taken
   * within the window. Releases only if we still own it (token CAS).
   */
  private async withCustomerCreditLimitLock<T>(
    customerId: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const redis = getRedisConnection();
    const lockKey = `autumn:credit-limit-lock:${customerId}`;
    const token = randomUUID();
    const LOCK_TTL_MS = 10_000;
    const MAX_WAIT_MS = 8_000;
    const POLL_MS = 100;

    const start = Date.now();
    let acquired = false;
    while (Date.now() - start < MAX_WAIT_MS) {
      const res = await redis.set(lockKey, token, "PX", LOCK_TTL_MS, "NX");
      if (res === "OK") {
        acquired = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    if (!acquired) {
      logger.warn("Could not acquire Autumn credit-limit lock", { customerId });
      return null;
    }

    try {
      return await fn();
    } finally {
      // Compare-and-delete so we never release a lock a later holder took over
      // after our TTL expired.
      try {
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          lockKey,
          token,
        );
      } catch (releaseError) {
        logger.warn("Failed to release Autumn credit-limit lock", {
          customerId,
          error: releaseError,
        });
      }
    }
  }

  /**
   * Rebuilds the customer's per-API-key credit limits in Autumn from our DB
   * (the source of truth). Reads every api_keys row for the team's org that has
   * a credit_limit set and replaces all apiKeyId-filtered CREDITS usage limits
   * with that set, preserving any unfiltered/other usage limits. The whole
   * read-and-write runs under a per-customer lock so concurrent key changes
   * can't drop one another's limit. Returns false when billing is unavailable
   * or the sync fails, so callers can surface/roll back.
   */
  async syncApiKeyCreditLimits(teamId: string): Promise<boolean> {
    if (!autumnClient || this.isPreviewTeam(teamId)) return false;

    try {
      const customerId = await this.ensureTrackingContext(teamId);

      const result = await this.withCustomerCreditLimitLock(
        customerId,
        async () => {
          // All keys across the org (the Autumn customer) with a limit set.
          // Read from the primary: this runs right after inserting a new key,
          // so the replica may not have the just-created row yet — missing it
          // would push to Autumn without the new key's cap.
          const rows = await db
            .select({
              id: schema.api_keys.id,
              credits: schema.api_keys.credit_limit,
              interval: schema.api_keys.credit_limit_interval,
            })
            .from(schema.api_keys)
            .innerJoin(
              schema.teams,
              eq(schema.teams.id, schema.api_keys.team_id),
            )
            .where(
              and(
                eq(schema.teams.org_id, customerId),
                // Both columns are required together (enforced by the DB CHECK);
                // gate on both so the rows we select match the rows we rebuild —
                // a half-configured row can never strip a limit without replacing it.
                isNotNull(schema.api_keys.credit_limit),
                isNotNull(schema.api_keys.credit_limit_interval),
              ),
            );

          const customer = await autumnClient!.customers.get({ customerId });
          const existing = customer.billingControls?.usageLimits ?? [];

          // Keep everything that isn't one of our apiKeyId-filtered CREDITS
          // limits (org-level caps, other-property filters), then re-add the
          // per-key limits authoritatively from the DB.
          const preserved = existing
            .filter(
              limit =>
                !(
                  limit.featureId === CREDITS_FEATURE_ID &&
                  limit.filter?.properties?.[API_KEY_CREDIT_LIMIT_PROPERTY] !==
                    undefined
                ),
            )
            .map(limit => ({
              featureId: limit.featureId,
              limit: limit.limit,
              interval: limit.interval as "day" | "week" | "month" | "year",
              enabled: limit.enabled,
              ...(limit.filter ? { filter: limit.filter } : {}),
            }));

          const perKey = rows
            .filter(row => row.credits !== null && row.interval !== null)
            .map(row => ({
              featureId: CREDITS_FEATURE_ID,
              limit: row.credits as number,
              interval: row.interval as "day" | "week" | "month",
              enabled: true,
              filter: {
                properties: { [API_KEY_CREDIT_LIMIT_PROPERTY]: row.id },
              },
            }));

          await autumnClient!.customers.update({
            customerId,
            billingControls: { usageLimits: [...preserved, ...perKey] },
          });

          return true;
        },
      );

      if (result === null) {
        logger.error("Autumn syncApiKeyCreditLimits could not acquire lock", {
          teamId,
          customerId,
        });
        return false;
      }

      logger.info("Autumn syncApiKeyCreditLimits succeeded", { customerId });
      return true;
    } catch (error) {
      logger.error("Autumn syncApiKeyCreditLimits failed", { teamId, error });
      return false;
    }
  }
}

export const autumnService = new AutumnService();
