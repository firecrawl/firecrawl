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
} from "./firebill";
import {
  autumnCustomerGetOrCreateTotal,
  autumnEntityCreatedInlineTotal,
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
} from "./types";

export const TEAM_FEATURE_ID = "TEAM";
export const CREDITS_FEATURE_ID = "CREDITS";
export const SEARCH_CREDITS_FEATURE_ID = "SEARCH_CREDITS";
/**
 * The balance hosted MCP calls spend before the endpoint's own feature (see
 * AutumnService.trackHostedMcpCredits). Configurable so the id can follow the
 * Autumn feature without a code change.
 */
export const MCP_CREDITS_FEATURE_ID = config.MCP_CREDITS_FEATURE_ID;
const CONCURRENCY_FEATURE_ID = "CONCURRENCY";
const RATE_LIMIT_FEATURE_ID = "rate_limits";

/**
 * The Autumn entity a charge on `featureId` is made against. MCP credits are
 * granted to the customer rather than to a team, so their charges, holds and
 * refunds carry no entity: with the team's entity, Autumn spends that team's
 * own balances first, including a team-scoped CREDITS grant, and leaves the
 * customer's MCP credits untouched.
 */
function billingEntityId(
  featureId: string,
  teamId: string,
): string | undefined {
  return featureId === MCP_CREDITS_FEATURE_ID ? undefined : teamId;
}

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
   * what makes the partner responsible for part of its usage.
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
   * Checks whether a team has enough balance to cover a request, through
   * firebill. Returns null when gating is unavailable and callers should fall
   * back.
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
    /** Set only for a Gateway account, funded by the platform that created it. */
    gatewayProvisioned?: boolean;
  } | null> {
    if (!firebillConfigured() || this.isPreviewTeam(teamId)) {
      return null;
    }
    try {
      const gatewayProvisioned = await this.isGatewayProvisioned(teamId);

      // firebill answers with the same arithmetic settlement uses, so a
      // gateway ghost's gate counts the partner pool rather than the ghost's
      // own balance — which a ghost is designed to overspend, and which would
      // otherwise 402 exactly the requests the pool exists to fund.
      //
      // `unavailable` becomes `null`, which this method's contract already
      // means "fail open".
      const result = await firebillCheck({
        customerId: orgId,
        entityId: billingEntityId(featureId, teamId) ?? "",
        featureId,
        value,
        properties,
      });
      if (result.status === "unavailable") return null;
      return {
        allowed: result.allowed,
        remaining: result.remaining,
        ...(gatewayProvisioned ? { gatewayProvisioned } : {}),
      };
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
   * The feature a hosted MCP request's charge, hold or check is made on, in
   * place of `featureId`: MCP credits, which Autumn spends first before
   * falling back to other balances. A partner-provisioned team keeps
   * `featureId`: its usage is split with the partner on the regular features.
   */
  async hostedMcpFeatureId(teamId: string, featureId: string): Promise<string> {
    return (await this.isGatewayProvisioned(teamId))
      ? featureId
      : MCP_CREDITS_FEATURE_ID;
  }

  /**
   * Whether the org has an auto top-up that can actually fire for CREDITS: it
   * is enabled, and the org holds a prepaid CREDITS item for it to buy. Autumn
   * enables the control on some free orgs, but a free plan has no prepaid item,
   * so nothing would ever be bought. Answers true when Autumn can't answer, so
   * callers fail open.
   */
  async hasAutoTopUp(orgId: string): Promise<boolean> {
    if (!autumnClient) return true;
    try {
      const customer = await autumnClient.customers.get({ customerId: orgId });
      const autoTopUp = customer.billingControls?.autoTopups?.some(
        topUp => topUp.featureId === CREDITS_FEATURE_ID && topUp.enabled,
      );
      const prepaid = customer.balances?.[CREDITS_FEATURE_ID]?.breakdown?.some(
        item => item.price?.billingMethod === "prepaid",
      );
      return !!autoTopUp && !!prepaid;
    } catch (error) {
      logger.warn("Autumn auto top-up lookup failed, failing open", {
        orgId,
        error,
      });
      return true;
    }
  }

  /**
   * Attempts to reserve a team's credits through firebill. See
   * {@link LockCreditsResult}.
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
    if (!firebillConfigured() || this.isPreviewTeam(teamId)) {
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
      // The hold still lives in Autumn (firebill keeps no lock state), but
      // only firebill pins the retry/timeout budget around the call. An
      // unavailable answer maps to "skipped" — proceed unlocked — except when
      // a partner gate is involved; see `unreachable` above.
      const result = await firebillLock({
        customerId: orgId,
        entityId: billingEntityId(featureId, teamId) ?? "",
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
   * Finalizes a previously-acquired Autumn lock through firebill, which
   * queues the settle durably and retries delivery — a dropped settle means
   * the hold just expires, leaving a confirm's work unbilled.
   *
   * A caller that cannot name the org passes no team. The lock id is all a
   * finalize needs, so an ordinary settle loses nothing by not knowing the org;
   * a run-token settle loses its partner report, as below.
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
    // Without firebill no hold was ever taken, so nothing can have gone
    // unsettled.
    if (!firebillConfigured()) return true;

    // Named only for a gated settle: firebill needs the org to split the
    // settle and to find the integration to report to. An ordinary finalize
    // does neither, so it does not carry one.
    //
    // A gated caller that cannot name the org passes no team and the settle
    // still lands, without the label. There is no durable retry on this path —
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

  /**
   * Records a credit usage event through firebill. Returns true on success.
   *
   * No fallback to Autumn on failure — firebill may already own the event.
   */
  async trackCredits({
    teamId,
    value,
    properties,
    featureId = CREDITS_FEATURE_ID,
    idempotencyKey,
    externalRequestId,
    durableRetry,
    orgId,
  }: TrackCreditsParams): Promise<boolean> {
    if (!firebillConfigured()) return false;
    if (this.isPreviewTeam(teamId)) return false;

    try {
      return await firebillTrack({
        customerId: orgId,
        entityId: billingEntityId(featureId, teamId),
        featureId,
        value,
        properties,
        idempotencyKey,
        externalRequestId,
        durableRetry,
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
   * Never throws; resolves true only when billing accepted the refund.
   */
  async refundCredits({
    teamId,
    value,
    properties,
    featureId = CREDITS_FEATURE_ID,
    idempotencyKey,
    externalRequestId,
    durableRetry,
    orgId,
  }: TrackCreditsParams): Promise<boolean> {
    if (!firebillConfigured()) return false;
    if (this.isPreviewTeam(teamId)) return false;

    try {
      return await firebillTrack({
        customerId: orgId,
        entityId: billingEntityId(featureId, teamId),
        featureId,
        value: -value,
        properties: { ...properties, source: "autumn_refund" },
        idempotencyKey,
        externalRequestId,
        durableRetry,
      });
    } catch (error) {
      logger.error(
        "Autumn refundCredits failed — billing API may be unavailable",
        { teamId, value, error },
      );
      return false;
    }
  }
}

export const autumnService = new AutumnService();
