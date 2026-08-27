import { randomUUID } from "crypto";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { sampled } from "../../lib/rollout";
import type { LockDeniedReason, TrackParams } from "./types";
import {
  firebillCheckTotal,
  firebillRetryTotal,
  firebillTrackTotal,
} from "./metrics";

/**
 * Outcome of a firebill `/v1/lock` call, mirroring firebill's three-state
 * answer: `denied` is Autumn saying no (a real answer — the caller must not
 * proceed), while `unavailable` means firebill couldn't get an answer out of
 * Autumn at all and the caller decides how its endpoint fails.
 */
type FirebillLockResult =
  | { status: "locked"; lockId: string; operationToken?: string }
  | { status: "denied"; reason?: LockDeniedReason }
  | { status: "unavailable" };

/**
 * An unrecognised reason is dropped rather than passed through: reading one we
 * do not understand as `job_revoked` would stop a customer's schedule.
 */
const LOCK_DENIED_REASONS: readonly LockDeniedReason[] = [
  "out_of_credits",
  "job_revoked",
  "gate_unavailable",
];

function lockDeniedReason(value: unknown): LockDeniedReason | undefined {
  return LOCK_DENIED_REASONS.find(reason => reason === value);
}

// firebill's own internal budget (durable write + forward attempt) is up to
// ~3.5s worst case, so this is deliberately looser than the 2s timeout on the
// direct Autumn client.
const FIREBILL_TIMEOUT_MS = 5000;

// A gated lock legitimately does more: firebill asks the partner (2.5s ceiling)
// before the Autumn hold (2s), on top of the funding lookup. Giving up at 5s
// would abandon a call that is still going to take the hold - the run marked
// skipped here, the balance reserved there.
const FIREBILL_GATED_LOCK_TIMEOUT_MS = 10000;

// Safe to retry because the idempotency key is stable across attempts: if the
// first attempt did land (ambiguous confirm timeout), Autumn dedupes the second.
// Small because a caller may be waiting, and a firebill refusing events usually
// cannot reach the broker — which more attempts will not fix.
const FIREBILL_ATTEMPTS = 2;
const FIREBILL_RETRY_DELAY_MS = 150;

// FIREBILL_ORG_IDS is decoded once at startup by the config schema; the Set is
// built lazily on first use and cached, keyed on the decoded array reference.
let allowlistCache: { source: string[] | undefined; ids: Set<string> } | null =
  null;

function firebillOrgIds(): Set<string> {
  const source = config.FIREBILL_ORG_IDS;
  if (!allowlistCache || allowlistCache.source !== source) {
    allowlistCache = {
      source,
      ids: new Set(
        (source ?? []).map(id => id.trim()).filter(id => id.length > 0),
      ),
    };
  }
  return allowlistCache.ids;
}

/**
 * Configured, without the rollout question — a finalize carrying a run token
 * follows the lock through firebill whatever the ramp says.
 */
export function firebillConfigured(): boolean {
  return Boolean(config.FIREBILL_URL && config.FIREBILL_SECRET);
}

/**
 * Whether this org's usage goes through firebill rather than straight to Autumn.
 * Needs firebill configured, then any of: the allowlist, being
 * partner-provisioned, or the sticky percentage.
 *
 * `gatewayProvisioned` is deliberately a parameter rather than a lookup in here:
 * this stays a pure function of config so it can be reasoned about and tested
 * without a database, and the caller already has the answer cached.
 *
 * It arrives in an options object rather than as a second positional argument
 * because this predicate is used as a callback — `orgs.filter(shouldRouteToFirebill)`
 * would otherwise pass the array *index* as it, routing everything but element
 * zero. Destructuring a field off a number yields undefined, so the object form
 * cannot be fooled that way.
 *
 * **This whole gateway branch is meant to be deleted.** It exists only because
 * the ramp is below 100: a gateway partner's usage must route deterministically,
 * and a sticky sample is a probability. At `FIREBILL_ROLLOUT_PERCENT=100` every
 * org routes anyway, the branch stops changing any outcome, and it — along with
 * the lookup feeding it — should go.
 */
export function shouldRouteToFirebill(
  orgId: string,
  opts?: { gatewayProvisioned?: boolean },
): boolean {
  if (!firebillConfigured()) return false;
  // Always-on set: test orgs stay routed even at 0 percent.
  if (firebillOrgIds().has(orgId)) return true;
  // A partner-provisioned org always routes: firebill is the only thing that
  // knows how to split its usage between that org's own balance and the
  // partner's, so a charge that misses firebill is billed wholly to an account
  // nobody pays for, and the partner is silently never charged.
  if (opts?.gatewayProvisioned) return true;
  // Sticky by org, so a ramp only ever adds and 0 is the kill switch.
  return sampled(orgId, config.FIREBILL_ROLLOUT_PERCENT);
}

// Plain concatenation rather than new URL(path, base): a leading-slash path
// would drop any base-path prefix (e.g. a reverse proxy at /firebill).
function firebillUrl(path: string): string {
  return `${config.FIREBILL_URL!.replace(/\/+$/, "")}${path}`;
}

/**
 * Sends a usage event to firebill, which publishes it to a durable quorum queue
 * and answers once the broker has confirmed it, then forwards it to Autumn from
 * a consumer (retrying failed deliveries instead of losing them).
 *
 * A negative value is a refund (refundCredits negates before calling track);
 * firebill's /v1/refund endpoint expects the POSITIVE amount and negates it
 * itself, so the absolute value is sent either way.
 *
 * Returns true when firebill accepted the event, mirroring the boolean
 * contract of the direct Autumn track path. A `false` means firebill never
 * took it: nothing is retrying, and the usage goes unbilled.
 */
export async function firebillTrack(params: TrackParams): Promise<boolean> {
  const operation = params.value < 0 ? "refund" : "track";
  const path = `/v1/${operation}`;
  // Both attempts must be the same event. Without a caller key firebill mints
  // one per request, so a retry after an accepted-but-lost first attempt would
  // be a second charge; minting here instead keeps one identity per call while
  // separate calls stay distinct, exactly as before.
  const attempted = {
    ...params,
    idempotencyKey: params.idempotencyKey ?? randomUUID(),
  };

  for (let attempt = 1; attempt < FIREBILL_ATTEMPTS; attempt++) {
    const result = await firebillAttempt(path, attempted);
    if (result.ok) {
      firebillTrackTotal.labels(operation, "accepted").inc();
      return true;
    }
    firebillRetryTotal.labels(result.reason).inc();
    await new Promise(resolve => setTimeout(resolve, FIREBILL_RETRY_DELAY_MS));
  }

  const last = await firebillAttempt(path, attempted);
  if (last.ok) {
    firebillTrackTotal.labels(operation, "accepted").inc();
    return true;
  }

  // `refused` only for an explicit `success: false`, which is firebill saying it
  // did not take the event. A transport failure is `ambiguous`: firebill may
  // have accepted it and be delivering it right now, so this is not proof of
  // lost usage. Either way the caller is told false and must not assume a
  // charge landed. A counter rather than a throw: billing must not fail the
  // customer's request, and a log alone is too quiet to alert on.
  const outcome = last.reason === "not_success" ? "refused" : "ambiguous";
  logger.error(
    outcome === "refused"
      ? "firebill refused a usage event; it will not be billed"
      : "firebill did not answer; the event may or may not have been accepted",
    {
      customerId: params.customerId,
      entityId: params.entityId,
      featureId: params.featureId,
      value: params.value,
      idempotencyKey: attempted.idempotencyKey,
      callerSuppliedKey: params.idempotencyKey !== undefined,
      path,
      attempts: FIREBILL_ATTEMPTS,
      reason: last.reason,
    },
  );
  firebillTrackTotal.labels(operation, outcome).inc();
  return false;
}

type AttemptResult =
  | { ok: true }
  | { ok: false; reason: "not_ok" | "not_success" | "exception" };

async function firebillAttempt(
  path: string,
  {
    customerId,
    entityId,
    featureId,
    value,
    properties,
    idempotencyKey,
  }: TrackParams,
): Promise<AttemptResult> {
  const url = firebillUrl(path);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.FIREBILL_SECRET}`,
        "content-type": "application/json",
      },
      // No overage flag needed: firebill itself pins Autumn's
      // overage_behavior to "overflow" on every upstream call, matching the
      // direct-Autumn path below.
      body: JSON.stringify({
        customer_id: customerId,
        entity_id: entityId,
        feature_id: featureId,
        value: Math.abs(value),
        properties,
        // firebill carries this to Autumn as the Idempotency-Key on every
        // attempt, so a requeued job re-billing the same work is deduped rather
        // than charged twice. Omitted → firebill mints a per-request UUID,
        // which dedupes only its own retries.
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      }),
      signal: AbortSignal.timeout(FIREBILL_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn("firebill track attempt failed — non-OK response", {
        customerId,
        entityId,
        featureId,
        value,
        path,
        status: response.status,
      });
      return { ok: false, reason: "not_ok" };
    }

    const body = (await response.json()) as { success?: boolean };
    if (body.success !== true) {
      logger.warn("firebill track attempt did not succeed", {
        customerId,
        entityId,
        featureId,
        value,
        path,
      });
      return { ok: false, reason: "not_success" };
    }

    logger.info("firebill track succeeded", {
      customerId,
      entityId,
      featureId,
      value,
      path,
    });
    return { ok: true };
  } catch (error) {
    // DO NOT fall back to Autumn directly: firebill may have accepted the event
    // before this failed, and the Autumn SDK sends no idempotency key, so the
    // pair could not be deduped and the customer would be billed twice.
    logger.warn("firebill track attempt failed — firebill may be unavailable", {
      customerId,
      entityId,
      featureId,
      value,
      path,
      error,
    });
    return { ok: false, reason: "exception" };
  }
}

/**
 * Holds balance via firebill's `/v1/lock`, the one synchronous firebill route:
 * firebill calls Autumn inline (it keeps no lock state of its own — Autumn
 * expires the hold by itself at `expiresAt`) and answers in three states.
 *
 * `unavailable` covers everything that isn't a real answer — firebill down,
 * non-OK response, or firebill reporting it couldn't reach Autumn. As with
 * track, there is deliberately no direct-Autumn fallback here: splitting one
 * lock's lifecycle across two routes would let a firebill-side hold and a
 * fallback hold coexist under retries.
 */
/**
 * Three outcomes, and callers must tell them apart: `answered` carries a real
 * yes/no, `unavailable` means firebill could not answer at all.
 */
type FirebillCheckResult =
  | { status: "answered"; allowed: boolean; remaining: number }
  | { status: "unavailable" };

/**
 * Asks firebill whether a customer can afford a charge.
 *
 * For a gateway-funded org this counts the funder's pool, which is the reason
 * it exists: a ghost spends credits it does not have, so a gate reading the
 * ghost's balance alone refuses the requests the partner pool is there to pay
 * for. firebill answers with the same arithmetic settlement uses.
 *
 * **Fails open, unlike {@link firebillTrack}.** Every failure maps to
 * `unavailable`, and the caller's contract is to let the request through.
 * Declining to charge loses nothing that cannot be replayed; declining to
 * *answer* an authorization question would turn a firebill blip into a
 * customer-facing outage. There is deliberately no retry either — this sits on
 * the request path, and a second round trip buys less than failing open fast.
 */
export async function firebillCheck({
  customerId,
  entityId,
  featureId,
  value,
  properties,
}: {
  customerId: string;
  entityId: string;
  featureId: string;
  value: number;
  properties?: Record<string, unknown>;
}): Promise<FirebillCheckResult> {
  const unavailable = (
    reason: string,
    extra?: Record<string, unknown>,
  ): FirebillCheckResult => {
    logger.error(`firebill check unavailable — ${reason}`, {
      customerId,
      entityId,
      featureId,
      value,
      ...extra,
    });
    firebillCheckTotal.labels("unavailable").inc();
    return { status: "unavailable" };
  };

  try {
    const response = await fetch(firebillUrl("/v1/check"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.FIREBILL_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        customer_id: customerId,
        entity_id: entityId,
        feature_id: featureId,
        value,
        properties,
      }),
      signal: AbortSignal.timeout(FIREBILL_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Release the socket. Returning without reading or cancelling leaves the
      // body unconsumed, and undici keeps the connection pinned until it is —
      // so a firebill that is erroring would exhaust the pool and turn one
      // failure into a run of them. Matters most here: this path is the one
      // that fails open, so the leak would be silently widening the window in
      // which credit checks are skipped.
      response.body?.cancel().catch(() => {});
      return unavailable("non-OK response", { status: response.status });
    }

    const body = (await response.json()) as {
      success?: boolean;
      allowed?: boolean;
      remaining?: number;
    };

    // `success: false` is firebill saying it does not know — an unanswered
    // balance, or a gateway lookup that failed. Never a denial.
    if (body.success !== true) {
      return unavailable("firebill could not answer");
    }
    // A missing or mis-shaped `allowed` is not something firebill sends today.
    // Reading it as a denial would 402 a paying customer, so it fails open.
    if (typeof body.allowed !== "boolean") {
      return unavailable("answered without a usable `allowed`");
    }

    // `remaining` clamps downstream limits, and the safe default inverts with
    // `allowed`, so there is no single one.
    //
    // `checkCreditsMiddleware` treats a denial with `remaining > 0` as a
    // *partial* crawl: it rewrites `limit` to that figure and calls `next()`
    // rather than returning 402. So defaulting a denial to `Infinity` would
    // turn "cannot afford this" into an unbounded crawl — the opposite of a
    // refusal, and worse than the 402 this endpoint exists to avoid.
    //
    // Allowed keeps `Infinity`, for the mirror-image reason: zero there would
    // silently shrink a crawl the customer *can* pay for down to nothing.
    // A usable figure is always preferred to either default.
    const remaining =
      typeof body.remaining === "number" && Number.isFinite(body.remaining)
        ? body.remaining
        : body.allowed
          ? Infinity
          : 0;

    firebillCheckTotal.labels(body.allowed ? "allowed" : "denied").inc();
    if (!body.allowed) {
      logger.info("firebill check denied", {
        customerId,
        entityId,
        featureId,
        value,
        remaining,
      });
    }
    return { status: "answered", allowed: body.allowed, remaining };
  } catch (error) {
    return unavailable("request threw", { error });
  }
}

export async function firebillLock({
  customerId,
  entityId,
  featureId,
  value,
  lockId,
  expiresAt,
  properties,
  partnerJobToken,
}: {
  customerId: string;
  entityId: string;
  featureId: string;
  value: number;
  lockId: string;
  expiresAt: number;
  properties?: Record<string, unknown>;
  partnerJobToken?: string | null;
}): Promise<FirebillLockResult> {
  const url = firebillUrl("/v1/lock");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.FIREBILL_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        customer_id: customerId,
        entity_id: entityId,
        feature_id: featureId,
        value,
        // Caller-chosen and deterministic — firebill never mints one, because
        // a minted id would be lost on a timeout, leaving a hold nobody can
        // finalize. Autumn enforces it as the lock's idempotency key.
        lock_id: lockId,
        expires_at: expiresAt,
        properties,
        // Present arms firebill's partner gate; omitted is today's path.
        ...(partnerJobToken ? { partner_job_token: partnerJobToken } : {}),
      }),
      signal: AbortSignal.timeout(
        partnerJobToken ? FIREBILL_GATED_LOCK_TIMEOUT_MS : FIREBILL_TIMEOUT_MS,
      ),
    });

    if (!response.ok) {
      logger.error("firebill lock failed — non-OK response", {
        customerId,
        entityId,
        featureId,
        value,
        lockId,
        status: response.status,
      });
      return { status: "unavailable" };
    }

    const body = (await response.json()) as {
      success?: boolean;
      allowed?: boolean;
      lock_id?: string;
      reason?: unknown;
      operation_token?: unknown;
    };

    if (body.success !== true) {
      logger.error("firebill lock did not succeed", {
        customerId,
        entityId,
        featureId,
        value,
        lockId,
      });
      return { status: "unavailable" };
    }

    if (body.allowed === false) {
      const reason = lockDeniedReason(body.reason);
      logger.info("firebill lock denied", {
        customerId,
        entityId,
        featureId,
        value,
        lockId,
        reason,
      });
      return { status: "denied", ...(reason ? { reason } : {}) };
    }

    // Only an explicit `allowed: false` is a denial. `success: true` with a
    // missing or mis-shaped `allowed` is not an answer firebill sends today;
    // treating it as a denial would hard-stop the check (skipped_no_credits),
    // so it maps to unavailable — proceed unlocked — instead.
    if (body.allowed !== true) {
      logger.error("firebill lock answered without a usable `allowed`", {
        customerId,
        entityId,
        featureId,
        value,
        lockId,
      });
      return { status: "unavailable" };
    }

    const operationToken =
      typeof body.operation_token === "string" &&
      body.operation_token.length > 0
        ? body.operation_token
        : undefined;

    logger.info("firebill lock succeeded", {
      customerId,
      entityId,
      featureId,
      value,
      lockId,
      gated: operationToken !== undefined,
    });
    return {
      status: "locked",
      lockId: body.lock_id ?? lockId,
      ...(operationToken ? { operationToken } : {}),
    };
  } catch (error) {
    logger.error("firebill lock failed — firebill may be unavailable", {
      customerId,
      entityId,
      featureId,
      value,
      lockId,
      error,
    });
    return { status: "unavailable" };
  }
}

/**
 * Settles a lock via firebill's `/v1/finalize`: `confirm` bills the hold,
 * `release` gives the balance back. firebill queues the settle durably and
 * retries it until it lands in Autumn, instead of dropping it when Autumn
 * blinks (the direct-Autumn path's failure mode — the lock then just expires,
 * which for a confirm means the work goes unbilled).
 *
 * Returns true when firebill accepted the settle for delivery, mirroring the
 * void-and-log contract of the direct finalize path. No direct-Autumn
 * fallback, for the same reason as track: firebill may have durably queued
 * the settle before the call failed.
 */
export async function firebillFinalize({
  lockId,
  action,
  overrideValue,
  properties,
  externalRequestId,
  customerId,
}: {
  lockId: string;
  action: "confirm" | "release";
  overrideValue?: number;
  properties?: Record<string, unknown>;
  externalRequestId?: string | null;
  customerId?: string | null;
}): Promise<boolean> {
  const url = firebillUrl("/v1/finalize");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.FIREBILL_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        lock_id: lockId,
        action,
        ...(overrideValue !== undefined
          ? { override_value: overrideValue }
          : {}),
        properties,
        // Deterministic per (lock, action): the lock id is itself caller-chosen
        // and stable (`monitor_${check.id}`), so a re-finalize of the same
        // settle — e.g. the reconciler re-running a check it raced — dedupes
        // upstream instead of settling twice.
        idempotency_key: `fc:finalize:${action}:${lockId}`,
        // The run token, brought home as this settle's operation id.
        ...(externalRequestId
          ? { external_request_id: externalRequestId }
          : {}),
        // Who the lock was for. The Autumn finalize body carries no customer
        // and firebill keeps no lock table, so without this it cannot find the
        // integration to report the run to.
        ...(customerId ? { customer_id: customerId } : {}),
      }),
      signal: AbortSignal.timeout(FIREBILL_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.error("firebill finalize failed — non-OK response", {
        lockId,
        action,
        overrideValue,
        status: response.status,
      });
      return false;
    }

    const body = (await response.json()) as { success?: boolean };
    if (body.success !== true) {
      logger.error("firebill finalize did not succeed", {
        lockId,
        action,
        overrideValue,
      });
      return false;
    }

    logger.info("firebill finalize succeeded", {
      lockId,
      action,
      overrideValue,
    });
    return true;
  } catch (error) {
    logger.error("firebill finalize failed — firebill may be unavailable", {
      lockId,
      action,
      overrideValue,
      error,
    });
    return false;
  }
}
