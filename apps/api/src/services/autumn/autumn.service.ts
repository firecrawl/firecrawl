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
import {
  autumnCustomerGetOrCreateTotal,
  autumnEntityCreatedInlineTotal,
  billingRouteTotal,
} from "./metrics";
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

/** A team's Autumn-derived limits and plan, as cached on its ACUC. */
export type TeamLimits = {
  concurrency_limit: number;
  rate_limit_multiplier: number;
  is_paid_plan: boolean;
};

/** Limits for a team with no elevated entitlement (a 404 or no balance). */
export const DEFAULT_TEAM_LIMITS: TeamLimits = {
  concurrency_limit: 2,
  rate_limit_multiplier: 1,
  is_paid_plan: false,
};

const AUTUMN_DEFAULT_PLAN_ID = "free";
// Mirrors FREE_PLAN_IDS in firecrawl-web's utils/autumn/pick-largest.ts.
const FREE_PLAN_IDS = new Set([AUTUMN_DEFAULT_PLAN_ID, "free_1_5k"]);
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
  private gatewayTeams = new BoundedSet<string>(50_000);
  private nonGatewayTeamsUntil = new BoundedMap<string, number>(50_000);
  private ensuredOrgs = new BoundedSet<string>(50_000);
  // Keyed by org AND team: an entity lives under one customer, so a team that
  // moves orgs has to be provisioned again under the new one.
  private ensuredTeams = new BoundedSet<string>(50_000);

  private ensuredTeamKey(orgId: string, teamId: string): string {
    return `${orgId}:${teamId}`;
  }

  private isPreviewTeam(teamId: string): boolean {
    return teamId === "preview" || teamId.startsWith("preview_");
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
      // Counted before the await so a call that reached Autumn and failed is
      // still counted; the counter measures attempts, not successes.
      autumnCustomerGetOrCreateTotal.inc();
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
      // Only a 404 establishes that the entity is missing. Let provisioning's
      // catch handle other failures without attempting to create the entity.
      throw error;
    }
  }

  private async createEntity({
    customerId,
    entityId,
    featureId,
    name,
    path,
  }: CreateEntityParams): Promise<CreateEntityResult> {
    if (!autumnClient) return { ok: false, conflict: false };

    try {
      const entity = await autumnClient.entities.create({
        customerId,
        entityId,
        featureId,
        name: name ?? undefined,
      });
      autumnEntityCreatedInlineTotal.labels(path).inc();
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
  async isRoutedThroughFirebill(
    teamId: string,
    orgId: string,
  ): Promise<boolean> {
    if (this.isPreviewTeam(teamId)) return false;
    try {
      const gatewayProvisioned = await this.isGatewayProvisioned(teamId);
      return shouldRouteToFirebill(orgId, { gatewayProvisioned });
    } catch {
      return false;
    }
  }

  /**
   * `routed` is decided by the caller (see {@link resolveBillingRoute}) rather
   * than asked again here: the answer costs a `partner_provisioned_accounts`
   * read on a cold team, and the caller already needed it to know whether to
   * provision.
   */
  private async track(
    {
      customerId,
      entityId,
      featureId,
      value,
      properties,
      idempotencyKey,
      externalRequestId,
    }: TrackParams,
    routed: boolean,
  ): Promise<boolean> {
    // Gradual rollout: allowlisted orgs, partner-provisioned orgs, and those in
    // sticky FIREBILL_ROLLOUT_PERCENT bucket bill through firebill. No fallback
    // to Autumn on failure — firebill may already own the event, and the SDK
    // sends no idempotency key, so the pair could not be deduped.
    if (routed) {
      billingRouteTotal.labels("firebill").inc();
      return await firebillTrack({
        customerId,
        entityId,
        featureId,
        value,
        properties,
        idempotencyKey,
        externalRequestId,
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
   * The `ensuredTeams` check runs before any Autumn call so that a team already
   * provisioned under its current org incurs no HTTP round-trips — not even
   * `ensureOrgProvisioned`.
   */
  async ensureTeamProvisioned({
    teamId,
    orgId,
    name,
  }: EnsureTeamProvisionedParams): Promise<void> {
    if (!autumnClient) return;
    if (this.isPreviewTeam(teamId)) return;

    try {
      // Fast path: team is already fully provisioned under this org.
      if (this.ensuredTeams.has(this.ensuredTeamKey(orgId, teamId))) {
        return;
      }
      await this.ensureOrgProvisioned({ orgId });

      const entity = await this.getEntity({
        customerId: orgId,
        entityId: teamId,
      });

      if (!entity) {
        const result = await this.createEntity({
          customerId: orgId,
          entityId: teamId,
          featureId: TEAM_FEATURE_ID,
          name,
          path: "ensureTeamProvisioned",
        });
        if (result.ok || ("conflict" in result && result.conflict)) {
          // Entity was just created, or already existed (409 race) — either way
          // it's present. No need for a second getEntity confirmation call.
          this.ensuredTeams.add(this.ensuredTeamKey(orgId, teamId));
        }
        // Genuine error: leave ensuredTeams empty so the next request retries.
        return;
      }

      this.ensuredTeams.add(this.ensuredTeamKey(orgId, teamId));
    } catch (error) {
      logger.error(
        "Autumn ensureTeamProvisioned failed — billing API may be unavailable",
        { teamId, error },
      );
    }
  }

  /**
   * Decides the route a team's billing takes, and warms the customer/entity
   * context the direct route needs. The customer is the caller's own org,
   * which this service never looks up for itself.
   *
   * **Provisioning runs on the direct route only.** firebill creates a missing
   * entity itself now, off the 404 `entity_not_found` Autumn answers the
   * billing call with, so the get/create prefix here would be a second,
   * redundant round trip — one that cannot change the answer either way,
   * because its failure is caught and the operation proceeds regardless.
   *
   * A team already provisioned under this org skips ensureTeamProvisioned
   * entirely.
   */
  private async resolveBillingRoute(
    teamId: string,
    orgId: string,
  ): Promise<{ customerId: string; routed: boolean }> {
    const routed = shouldRouteToFirebill(orgId, {
      gatewayProvisioned: await this.isGatewayProvisioned(teamId),
    });
    if (!routed && !this.ensuredTeams.has(this.ensuredTeamKey(orgId, teamId))) {
      await this.ensureTeamProvisioned({ teamId, orgId });
    }
    return { customerId: orgId, routed };
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
    orgId,
  }: TrackCreditsParams): Promise<{
    allowed: boolean;
    remaining: number;
  } | null> {
    if (!autumnClient || this.isPreviewTeam(teamId)) {
      return null;
    }
    try {
      const { customerId, routed } = await this.resolveBillingRoute(
        teamId,
        orgId,
      );

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
      if (routed) {
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
    orgId,
  }: LockCreditsParams): Promise<LockCreditsResult> {
    if (!autumnClient || this.isPreviewTeam(teamId)) {
      return { status: "skipped" };
    }
    const resolvedLockId = lockId ?? `billing_${randomUUID()}`;

    // An ordinary hold proceeds unlocked; refusing would turn a firebill blip
    // into a customer outage. A gated run is the opposite: no answer means no
    // run token, so the work could never be billed. firebill fails closed when
    // it cannot reach the partner, but it cannot do so when it is the thing
    // that is down.
    const unreachable = (): LockCreditsResult =>
      partnerJobToken
        ? { status: "denied", reason: "gate_unavailable" }
        : { status: "skipped" };

    try {
      const { customerId, routed } = await this.resolveBillingRoute(
        teamId,
        orgId,
      );

      // Gradual firebill rollout, mirroring track(): allowlisted orgs take
      // their holds through firebill. The hold still lives in Autumn (firebill
      // keeps no lock state), but only firebill pins the retry/timeout budget
      // around the call. An unavailable answer maps to "skipped" — proceed
      // unlocked — like a direct-Autumn check failure below, except when a
      // partner gate is involved; see `unreachable` above.
      if (routed) {
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

      // Unreachable — a partner-provisioned org always routes to firebill
      // (#4403) — but a token here would silently skip the gate.
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
      // A gated run that threw before asking anyone is still unauthorized.
      return unreachable();
    }
  }

  /**
   * Finalizes a previously-acquired Autumn lock.
   *
   * When the caller supplies the lock's team and that team's org is on the
   * firebill rollout, the settle goes through firebill, which queues it
   * durably and retries delivery — a dropped direct finalize means the hold
   * just expires, leaving a confirm's work unbilled. Either route lands on the
   * same Autumn lock, so routing is a durability choice, not a correctness one.
   *
   * **Except with a run token in hand**, where it is a correctness choice: only
   * firebill reports the operation to the partner, and the routing predicate is
   * not stable across the hour between a lock and its finalize. The token is
   * proof of the route the lock took, so it wins over asking again.
   */
  async finalizeCreditsLock({
    lockId,
    action,
    overrideValue,
    properties,
    team,
    externalRequestId,
    featureId = CREDITS_FEATURE_ID,
    heldValue,
  }: FinalizeCreditsLockParams): Promise<boolean> {
    const gated = Boolean(externalRequestId) && firebillConfigured();
    if (
      gated ||
      (team && (await this.isRoutedThroughFirebill(team.teamId, team.orgId)))
    ) {
      // Named only for a gated settle: firebill needs the org to split the
      // settle and to find the integration to report to. An ordinary finalize
      // does neither, so it does not carry one. Nothing is provisioned here —
      // every settle on this branch goes through firebill, which provisions
      // what it needs (see resolveBillingRoute).
      //
      // A caller that cannot name the org passes no team and the settle still
      // lands, without the label. There is no durable retry on this path —
      // `billMonitorCheck`'s only caller catches, writes
      // `billing_status: "failed"`, and moves on, and nothing ever reads that
      // back — so refusing would abandon the finalize entirely: the hold
      // expires and the run goes unbilled at Autumn as well as unreported.
      // Settling and losing the label is the lesser loss, and firebill counts
      // the lost label as `partner_events_total{outcome="no_customer"}`.
      const customerId = externalRequestId && team ? team.orgId : null;
      // Surfaced, not discarded. firebill answers `false` for a refusal, a
      // timeout, or a non-OK — none of which throw — so a caller that ignores
      // this records a run as billed that nobody billed.
      return await firebillFinalize({
        lockId,
        action,
        overrideValue,
        properties,
        externalRequestId,
        customerId,
        featureId: customerId ? featureId : null,
        heldValue: customerId ? heldValue : null,
      });
    }

    // No client means no hold was ever taken, so nothing can have gone
    // unsettled.
    if (!autumnClient) return true;

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
      return true;
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
      return false;
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
    externalRequestId,
    orgId,
  }: TrackCreditsParams): Promise<boolean> {
    if (!autumnClient) return false;
    if (this.isPreviewTeam(teamId)) return false;

    try {
      const { customerId, routed } = await this.resolveBillingRoute(
        teamId,
        orgId,
      );
      return await this.track(
        {
          customerId,
          entityId: teamId,
          featureId,
          value,
          properties,
          idempotencyKey,
          externalRequestId,
        },
        routed,
      );
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
   * The team's limits from one uncached Autumn entity read, and its plan from
   * a customer read made in parallel (the ACUC caches both). An entity 404
   * gives the low default limits; a customer 404 gives no paid plan. A team is on a paid plan when its org has an
   * active, non-add-on subscription to a plan outside FREE_PLAN_IDS. Throws
   * when Autumn errors or the team has no org.
   */
  async getTeamLimits(
    teamId: string,
    orgId: string | null,
  ): Promise<TeamLimits> {
    if (!autumnClient || this.isPreviewTeam(teamId)) {
      return DEFAULT_TEAM_LIMITS;
    }
    if (!orgId) throw new Error("The team has no org to read limits for");

    const nullOn404 = (error: unknown) => {
      if (this.getErrorStatus(error) === 404) return null;
      throw error;
    };
    const [entity, customer] = await Promise.all([
      autumnClient.entities
        .get({ customerId: orgId, entityId: teamId })
        .catch(nullOn404),
      autumnClient.customers.get({ customerId: orgId }).catch(nullOn404),
    ]);
    const balances: Record<string, any> = entity?.balances ?? {};

    return {
      // CONCURRENCY: use `remaining` (the post-drain effective per-team cap;
      // `granted` would surface the pre-drain inherited customer total).
      concurrency_limit:
        sanitizeBalanceValue(balances[CONCURRENCY_FEATURE_ID]?.remaining) ??
        DEFAULT_TEAM_LIMITS.concurrency_limit,
      // rate_limits: a static per-plan multiplier that is never consumed, so
      // read `granted` (the entitled amount) rather than `remaining`.
      rate_limit_multiplier:
        sanitizeBalanceValue(balances[RATE_LIMIT_FEATURE_ID]?.granted) ??
        DEFAULT_TEAM_LIMITS.rate_limit_multiplier,
      is_paid_plan: (customer?.subscriptions ?? []).some(
        subscription =>
          subscription.status === "active" &&
          !subscription.addOn &&
          !FREE_PLAN_IDS.has(subscription.planId),
      ),
    };
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
    externalRequestId,
    orgId,
  }: TrackCreditsParams): Promise<void> {
    if (!autumnClient) return;
    if (this.isPreviewTeam(teamId)) return;

    try {
      const { customerId, routed } = await this.resolveBillingRoute(
        teamId,
        orgId,
      );
      await this.track(
        {
          customerId,
          entityId: teamId,
          featureId,
          value: -value,
          properties: { ...properties, source: "autumn_refund" },
          idempotencyKey,
          externalRequestId,
        },
        routed,
      );
    } catch (error) {
      logger.error(
        "Autumn refundCredits failed — billing API may be unavailable",
        { teamId, value, error },
      );
    }
  }
}

export const autumnService = new AutumnService();
