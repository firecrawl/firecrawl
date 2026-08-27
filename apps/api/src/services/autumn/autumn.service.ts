import { randomUUID } from "crypto";
import { logger } from "../../lib/logger";
import { eq } from "drizzle-orm";
import { dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { config } from "../../config";
import { autumnClient } from "./client";
import {
  firebillFinalize,
  firebillLock,
  firebillTrack,
  firebillCheck,
  firebillConfigured,
  shouldRouteToFirebill,
} from "./firebill";
import { billingRouteTotal } from "./metrics";
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
const CONCURRENCY_FEATURE_ID = "CONCURRENCY";
const RATE_LIMIT_FEATURE_ID = "rate_limits";

/**
 * Coerces a raw Autumn balance figure into a usable non-negative number, or
 * null when it's absent or not a sane finite value. These balances feed
 * directly into rate-limit and concurrency controls, so NaN, Infinity, and
 * negatives are rejected rather than passed through a bare `typeof` check.
 */
function sanitizeBalanceValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

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
  private gatewayTeams = new BoundedSet<string>(50_000);
  private nonGatewayTeamsUntil = new BoundedMap<string, number>(50_000);
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

  /**
   * Whether this team is an account a gateway partner provisioned, which is
   * what makes the partner responsible for part of its usage, and forces it
   * through firebill.
   *
   * Reads `partner_provisioned_accounts` rather than any config, because these
   * are created at runtime by the partner API — an allowlist of org ids cannot
   * keep up, and every new one would otherwise need a config change and a
   * fleet restart before its usage billed correctly.
   *
   * Existence of the row is the question, deliberately — not the integration's
   * `gateway_enabled` flag. Provisioning is the durable fact; whether to split
   * right now is firebill's to decide, and keeping the kill switch there means
   * flipping it stops splitting without also changing which service bills.
   *
   * Never throws: an unanswerable lookup falls back to "not gateway", which is
   * the same outcome as this code not existing. Wrong in the direction of a
   * missed split rather than a failed customer request.
   */
  private async isGatewayProvisioned(teamId: string): Promise<boolean> {
    if (this.gatewayTeams.has(teamId)) return true;

    const trustedUntil = this.nonGatewayTeamsUntil.get(teamId);
    if (trustedUntil !== undefined && trustedUntil > Date.now()) return false;

    try {
      const [row] = await dbRr
        .select({ team_id: schema.partner_provisioned_accounts.team_id })
        .from(schema.partner_provisioned_accounts)
        .where(eq(schema.partner_provisioned_accounts.team_id, teamId))
        .limit(1);

      if (row) {
        this.gatewayTeams.add(teamId);
        return true;
      }

      const ttlMs = config.FIREBILL_GATEWAY_NEGATIVE_TTL_SECONDS * 1000;
      if (ttlMs > 0) {
        this.nonGatewayTeamsUntil.set(teamId, Date.now() + ttlMs);
      }
      return false;
    } catch (error) {
      // Do not cache a failure as a negative: that would turn one blip into a
      // TTL's worth of partner usage billed to the wrong account.
      logger.warn(
        "gateway provisioning lookup failed; treating as not gateway",
        {
          teamId,
          error,
        },
      );
      return false;
    }
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

  /**
   * Whether this team's usage is currently routed through firebill. Used by
   * billers to pick route-specific failure handling (on the firebill route a
   * recorded charge stands and dedupes, so compensating refunds and duplicate
   * enqueues behave differently). Never throws: an error means "not routed",
   * falling back to the pre-firebill behavior.
   */
  async isRoutedThroughFirebill(teamId: string): Promise<boolean> {
    if (this.isPreviewTeam(teamId)) return false;
    try {
      const [orgId, gatewayProvisioned] = await Promise.all([
        this.resolveOrgId(teamId),
        this.isGatewayProvisioned(teamId),
      ]);
      return shouldRouteToFirebill(orgId, { gatewayProvisioned });
    } catch {
      return false;
    }
  }

  private async track({
    customerId,
    entityId,
    featureId,
    value,
    properties,
    idempotencyKey,
  }: TrackParams): Promise<boolean> {
    // Gradual rollout: allowlisted orgs, partner-provisioned orgs, and those in
    // sticky FIREBILL_ROLLOUT_PERCENT bucket bill through firebill. No fallback
    // to Autumn on failure — firebill may already own the event, and the SDK
    // sends no idempotency key, so the pair could not be deduped.
    // No entity means no team, and every provisioned account has one — so there
    // is nothing to look up.
    const gatewayProvisioned = entityId
      ? await this.isGatewayProvisioned(entityId)
      : false;
    if (shouldRouteToFirebill(customerId, { gatewayProvisioned })) {
      billingRouteTotal.labels("firebill").inc();
      return await firebillTrack({
        customerId,
        entityId,
        featureId,
        value,
        properties,
        idempotencyKey,
      });
    }

    billingRouteTotal.labels("direct").inc();

    if (!autumnClient) return false;

    try {
      await autumnClient.track({
        customerId,
        entityId,
        featureId,
        value,
        properties,
        overageBehavior: "overflow",
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

      // Mirrors track() and lockCredits(). Without this branch the gate reads
      // the ghost's balance alone, and a gateway ghost is designed to spend
      // credits it does not have — so it would 402 exactly the requests the
      // partner pool exists to fund. firebill answers with the same arithmetic
      // settlement uses.
      //
      // `unavailable` becomes `null`, which this method's existing contract
      // already means "fail open" — the same answer a null from Autumn gets
      // below, for the same reason.
      //
      // `gatewayProvisioned` matters more here than on the charge paths. A
      // partner-provisioned org that misses firebill on a *charge* is billed to
      // the wrong account; one that misses firebill on the *gate* is refused
      // outright, because Autumn is asked about a balance the org was never
      // meant to pay from. So the org this most needs to reach firebill is
      // exactly the one a sampling bucket might leave behind.
      if (
        shouldRouteToFirebill(customerId, {
          gatewayProvisioned: await this.isGatewayProvisioned(teamId),
        })
      ) {
        const result = await firebillCheck({
          customerId,
          entityId: teamId,
          featureId,
          value,
          properties,
        });
        if (result.status === "unavailable") return null;
        return { allowed: result.allowed, remaining: result.remaining };
      }

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
    partnerJobToken,
  }: LockCreditsParams): Promise<LockCreditsResult> {
    if (!autumnClient || this.isPreviewTeam(teamId)) {
      return { status: "skipped" };
    }
    const resolvedLockId = lockId ?? `billing_${randomUUID()}`;

    // firebill could not answer. For an ordinary hold that is "proceed
    // unlocked" — losing a reservation is recoverable and refusing one would
    // turn a firebill blip into a customer outage.
    //
    // For a gated run it is the opposite, and the asymmetry is the whole point
    // of the gate: no answer means no run token, so the work could never be
    // billed to the partner and doing it would mean doing it for free. firebill
    // fails closed when it cannot reach the partner; it cannot fail closed on
    // its own behalf when it is the thing that is down, so that has to happen
    // here. Only token-bearing locks are affected — every other caller of this
    // method keeps today's behaviour exactly.
    const unreachable = (): LockCreditsResult =>
      partnerJobToken
        ? { status: "denied", reason: "gate_unavailable" }
        : { status: "skipped" };

    try {
      const customerId = await this.ensureTrackingContext(teamId);

      // Gradual firebill rollout, mirroring track(): allowlisted orgs take
      // their holds through firebill. The hold still lives in Autumn (firebill
      // keeps no lock state), but only firebill pins the retry/timeout budget
      // around the call. An unavailable answer maps to "skipped" — proceed
      // unlocked — exactly like a direct-Autumn check failure below, EXCEPT
      // when a partner gate is involved; see `unreachable` below.
      if (
        shouldRouteToFirebill(customerId, {
          gatewayProvisioned: await this.isGatewayProvisioned(teamId),
        })
      ) {
        const result = await firebillLock({
          customerId,
          entityId: teamId,
          featureId,
          value,
          lockId: resolvedLockId,
          // firebill requires an expiry (Autumn releasing the hold by itself
          // is what makes firebill lock-table-free); default to an hour, the
          // monitor runner's convention, when the caller sets none.
          expiresAt: expiresAt ?? Date.now() + 60 * 60 * 1000,
          properties,
          partnerJobToken,
        });
        if (result.status === "locked") {
          return {
            status: "locked",
            lockId: result.lockId,
            ...(result.operationToken
              ? { operationToken: result.operationToken }
              : {}),
          };
        }
        if (result.status === "denied") {
          return {
            status: "denied",
            ...(result.reason ? { reason: result.reason } : {}),
          };
        }
        return unreachable();
      }

      // Direct Autumn cannot ask a partner anything. Unreachable in practice —
      // a partner-provisioned org always routes to firebill, whatever the ramp
      // says (#4403) — but a token that got here would silently skip the gate,
      // which is the one failure this whole path exists to prevent.
      if (partnerJobToken) {
        logger.error(
          "A partner job token reached the direct-Autumn lock path, where no partner can be asked; refusing the hold",
          { teamId, lockId: resolvedLockId },
        );
        return { status: "denied", reason: "gate_unavailable" };
      }

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
      // Same asymmetry: a gated run that threw before it could ask anyone is
      // still a run nobody authorized.
      return unreachable();
    }
  }

  /**
   * Finalizes a previously-acquired Autumn lock.
   *
   * When the caller supplies the lock's teamId and that team's org is on the
   * firebill rollout, the settle goes through firebill, which queues it
   * durably and retries delivery — a dropped direct finalize means the hold
   * just expires, leaving a confirm's work unbilled. Either route lands on the
   * same Autumn lock, so routing is a durability choice, not a correctness one.
   *
   * **Except when a run token is in hand.** Then it is a correctness choice:
   * only firebill can report the operation to the partner, so a finalize that
   * goes direct silently drops the report. And the routing predicate is not
   * stable across the hour between a lock and its finalize — it re-derives from
   * a TTL-cached provisioning lookup and a rollout percentage, either of which
   * can flip in between. A run token only exists because firebill minted it on
   * the lock, so its presence is proof of the route the lock actually took, and
   * it wins over asking again.
   */
  async finalizeCreditsLock({
    lockId,
    action,
    overrideValue,
    properties,
    teamId,
    externalRequestId,
  }: FinalizeCreditsLockParams): Promise<void> {
    const gated = Boolean(externalRequestId) && firebillConfigured();
    if (gated || (teamId && (await this.isRoutedThroughFirebill(teamId)))) {
      await firebillFinalize({
        lockId,
        action,
        overrideValue,
        properties,
        externalRequestId,
      });
      return;
    }

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
    idempotencyKey,
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
        idempotencyKey,
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

  // Cache the team's entity-derived limits briefly so concurrency enforcement
  // and rate-limit gating on every scrape/crawl/browser request don't fan out
  // to Autumn each time. Both the CONCURRENCY limit and the rate-limit
  // multiplier come from a single entity.get, so one cache entry (and one
  // Autumn round-trip per team per TTL window) serves both callers.
  private entityLimitsCache = new BoundedMap<
    string,
    {
      concurrency: number | null;
      rateLimitMultiplier: number | null;
      expiresAt: number;
    }
  >(50_000);
  private static readonly ENTITY_LIMITS_TTL_MS = 60_000;

  // Fail-open fallbacks used ONLY when Autumn itself errors (network / 5xx /
  // unexpected exception) so a billing-API outage doesn't throttle real
  // customers down to the low defaults. A 404 or an absent balance is NOT an
  // error — it legitimately means the team has no elevated entitlement, so
  // those keep falling back low (concurrency 2, multiplier 1). These values are
  // intentionally generous but bounded (the concurrency queue cap still
  // applies).
  private static readonly ERROR_FALLBACK_CONCURRENCY = 200;
  private static readonly ERROR_FALLBACK_RATE_MULTIPLIER = 2500;

  /**
   * Fetches the team's Autumn entity once and derives both the CONCURRENCY
   * limit and the rate-limit multiplier from it. Each team has its own Autumn
   * entity, so the entity balances are per-team regardless of whether the org
   * has one or many teams.
   *
   * Returns nulls when Autumn is not configured, the entity is missing (404),
   * or a balance isn't present — these mean "no elevated entitlement", so
   * callers fall back to the low defaults. When Autumn itself errors (network /
   * 5xx / unexpected exception) we instead fail OPEN, returning the high
   * ERROR_FALLBACK_* limits so a billing outage doesn't throttle real teams.
   */
  private async getEntityLimits(
    teamId: string,
    orgId?: string | null,
  ): Promise<{
    concurrency: number | null;
    rateLimitMultiplier: number | null;
  }> {
    if (!autumnClient || this.isPreviewTeam(teamId)) {
      return { concurrency: null, rateLimitMultiplier: null };
    }

    const now = Date.now();
    const cached = this.entityLimitsCache.get(teamId);
    if (cached && cached.expiresAt > now) {
      return {
        concurrency: cached.concurrency,
        rateLimitMultiplier: cached.rateLimitMultiplier,
      };
    }

    const store = (
      concurrency: number | null,
      rateLimitMultiplier: number | null,
    ) => {
      this.entityLimitsCache.set(teamId, {
        concurrency,
        rateLimitMultiplier,
        expiresAt: now + AutumnService.ENTITY_LIMITS_TTL_MS,
      });
      return { concurrency, rateLimitMultiplier };
    };

    try {
      const resolvedOrgId = orgId ?? (await this.resolveOrgId(teamId));
      if (!resolvedOrgId)
        return { concurrency: null, rateLimitMultiplier: null };

      const entity: any = await autumnClient.entities.get({
        customerId: resolvedOrgId,
        entityId: teamId,
      });
      const balances = entity?.balances ?? {};

      // CONCURRENCY: use `remaining` (the post-drain effective per-team cap;
      // `granted` would surface the pre-drain inherited customer total).
      const concurrency = sanitizeBalanceValue(
        balances[CONCURRENCY_FEATURE_ID]?.remaining,
      );

      // rate_limits: a static per-plan multiplier that is never consumed, so
      // read `granted` (the entitled amount) rather than `remaining`.
      const rateLimitMultiplier = sanitizeBalanceValue(
        balances[RATE_LIMIT_FEATURE_ID]?.granted,
      );

      return store(concurrency, rateLimitMultiplier);
    } catch (error) {
      const status = this.getErrorStatus(error);
      // 404 = the entity genuinely doesn't exist in Autumn (not an error):
      // fall back low, and cache it so we don't re-query for a team we know is
      // absent.
      if (status === 404) return store(null, null);
      // Any other failure means we couldn't reach Autumn / it errored. Fail
      // OPEN with high limits rather than throttling the team to the low
      // defaults. Deliberately not cached, so we retry Autumn on the next
      // request instead of pinning the team to the fallback for the TTL window.
      logger.error(
        "Autumn getEntityLimits failed — billing API may be unavailable, falling back to high limits",
        { teamId, error },
      );
      return {
        concurrency: AutumnService.ERROR_FALLBACK_CONCURRENCY,
        rateLimitMultiplier: AutumnService.ERROR_FALLBACK_RATE_MULTIPLIER,
      };
    }
  }

  /**
   * Reads the team's allowed concurrent-browser count from Autumn's
   * entity-scoped CONCURRENCY balance. Returns null when the entity is missing
   * or there's no balance — callers fall back to the low default via
   * getEffectiveConcurrencyLimit. On an Autumn error it returns the high
   * ERROR_FALLBACK_CONCURRENCY (fail open) rather than null.
   */
  async getConcurrencyLimit(
    teamId: string,
    orgId?: string | null,
  ): Promise<number | null> {
    return (await this.getEntityLimits(teamId, orgId)).concurrency;
  }

  /**
   * Reads the team's rate-limit multiplier from Autumn's `rate_limits` feature.
   * Effective rate limits are `base × multiplier`. Falls back to a multiplier of
   * 1 when the feature is missing or the entity doesn't exist, so callers don't
   * have to; on an Autumn error it fails open with the high
   * ERROR_FALLBACK_RATE_MULTIPLIER instead. Shares a single cached entity fetch
   * with getConcurrencyLimit, so it adds no Autumn call.
   */
  async getRateLimitMultiplier(
    teamId: string,
    orgId?: string | null,
  ): Promise<number> {
    return (await this.getEntityLimits(teamId, orgId)).rateLimitMultiplier ?? 1;
  }

  /**
   * Reverses a prior trackCredits call by tracking a negative usage event.
   */
  async refundCredits({
    teamId,
    value,
    properties,
    featureId = CREDITS_FEATURE_ID,
    idempotencyKey,
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
        idempotencyKey,
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
