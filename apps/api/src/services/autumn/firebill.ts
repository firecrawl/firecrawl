import { randomUUID } from "crypto";
import { z } from "zod";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { sampled } from "../../lib/rollout";
import type { LockDeniedReason, TrackParams } from "./types";
import {
  firebillCheckTotal,
  firebillFailureCauseTotal,
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

/**
 * Why a firebill call did not produce a usable answer, at a cardinality safe to
 * put on a counter. **`timeout` and `connection` are ours, not firebill's**:
 * the request never completed, so firebill never answered and may never have
 * been reached.
 *
 * - `non_ok` — firebill answered, with a status we cannot use.
 * - `unusable` — firebill answered, and the answer is not one we can read: an
 *   empty or malformed body, or a shape missing the field we asked for. **Not a
 *   refusal**: an event may well have been accepted and said so in a body we
 *   could not parse.
 * - `refused` — firebill answered `success: false`. On `/v1/track` that means
 *   it did not take the event; on `/v1/check` it means it declined to answer.
 * - `ambiguous` — firebill answered "I do not know" (a 504, or `ambiguous:
 *   true`): the broker may hold the event already.
 */
type FirebillCause =
  | "timeout"
  | "connection"
  | "non_ok"
  | "unusable"
  | "refused"
  | "ambiguous";

/** What a thrown fetch tells us, once it is unwrapped. */
type TransportFailure = {
  cause: "timeout" | "connection";
  errorName?: string;
  errorCode?: string;
};

const TIMEOUT_NAMES = new Set(["AbortError", "TimeoutError"]);
const TIMEOUT_CODES = new Set([
  "ABORT_ERR",
  "UND_ERR_ABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * Classify a thrown fetch: a deadline we imposed, or a socket/DNS failure.
 *
 * Walks `cause`, because undici reports the real error nested inside a bare
 * `TypeError: fetch failed` — reading only the top level would call every
 * ECONNREFUSED a generic exception.
 *
 * Anything that is not recognisably one of our deadlines is `connection`:
 * ECONNREFUSED, ECONNRESET, EPIPE, ENOTFOUND, EAI_AGAIN and their kin all mean
 * the request never got an answer, which is the distinction that matters.
 */
function classifyTransportError(error: unknown): TransportFailure {
  let name: string | undefined;
  let code: string | undefined;
  let cause: "timeout" | "connection" = "connection";

  // Innermost wins: the outer frame of a wrapped error is always
  // `TypeError: fetch failed`, which identifies nothing.
  for (let node: unknown = error, depth = 0; node && depth < 5; depth++) {
    const candidate = node as { name?: string; code?: string; cause?: unknown };
    if (typeof candidate.name === "string") name = candidate.name;
    if (typeof candidate.code === "string") code = candidate.code;
    if (
      (candidate.name && TIMEOUT_NAMES.has(candidate.name)) ||
      (candidate.code && TIMEOUT_CODES.has(candidate.code))
    ) {
      cause = "timeout";
      break;
    }
    node = candidate.cause;
  }

  return {
    cause,
    ...(name ? { errorName: name } : {}),
    ...(code ? { errorCode: code } : {}),
  };
}

/**
 * A body that arrived and would not parse — as distinct from one that never
 * finished arriving, which is a transport failure and is thrown.
 */
const UNUSABLE_BODY = Symbol("unusable body");

/** Whether a thrown error is, anywhere down its `cause` chain, a parse error. */
function isSyntaxError(error: unknown): boolean {
  for (let node: unknown = error, depth = 0; node && depth < 5; depth++) {
    if (node instanceof SyntaxError) return true;
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Read a JSON body, separating "firebill sent something we cannot read" from
 * "the body never arrived".
 *
 * **Only a parse error is caught.** A body that times out or loses its
 * connection after the headers arrived throws here too, and swallowing it would
 * report a transport failure as an answer firebill gave — the exact confusion
 * this file is being changed to remove. Those are re-thrown so
 * {@link classifyTransportError} sees them.
 *
 * Releases the socket either way: undici holds the connection until the body is
 * consumed, so a firebill that is erroring would otherwise exhaust the pool and
 * turn one failure into a run of them.
 */
async function readJson(
  response: Response,
): Promise<Record<string, unknown> | typeof UNUSABLE_BODY> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    if (!isSyntaxError(error)) throw error;
    response.body?.cancel().catch(() => {});
    return UNUSABLE_BODY;
  }
}

/**
 * **firebill saying "I do not know".** A publish whose broker confirm timed out
 * may have been taken anyway, so firebill answers `504` with
 * `{"success": false, "ambiguous": true}` rather than the `{"success": false}`
 * it sends when it is certain it took nothing.
 *
 * Read by field first and status second: the field is the contract, and the
 * status is what an older firebill and every proxy in between would give us.
 */
function saysAmbiguous(
  status: number,
  body: Record<string, unknown> | typeof UNUSABLE_BODY,
): boolean {
  return (body !== UNUSABLE_BODY && body.ambiguous === true) || status === 504;
}

// firebill's answer bodies (firebill `src/api.rs`). `success` discriminates: it
// sends `allowed`/`remaining` (check) and `allowed`/`lock_id`/… (lock) only when
// `success: true`. Splitting the arms keeps an explicit `success: false`
// (`refused`) distinct from a shape that matches neither (`unusable`).

// `ambiguous` is read off the raw body by saysAmbiguous before this.
const usageAnswerSchema = z.object({ success: z.boolean() });

// `remaining` is lenient — a missing or non-finite figure falls back to the
// clamp below rather than discarding the answer.
const checkAnswerSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    allowed: z.boolean(),
    remaining: z.number().finite().optional().catch(undefined),
  }),
  z.object({ success: z.literal(false) }),
]);

// `lock_id` is caught to undefined so a mis-shaped echo falls back to the
// caller's own id; reason/operation_token are validated where they are read.
const lockAnswerSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    allowed: z.boolean(),
    lock_id: z.string().optional().catch(undefined),
    reason: z.unknown().optional(),
    operation_token: z.unknown().optional(),
  }),
  z.object({ success: z.literal(false) }),
]);

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

  // **`refused` only for an explicit `success: false`.** That is firebill
  // saying it did not take the event, and it is the one case that is proof the
  // usage is gone — which is what the alert on this label means. Everything
  // else is `ambiguous`: firebill may have accepted it and be delivering it
  // right now. A confirm timeout now says so itself (a 504, or `ambiguous:
  // true`); before that it arrived as a plain `success: false` and was logged
  // 2,100 times over eight days as usage that would never be billed, all of
  // which had in fact settled.
  //
  // Either way the caller is told false and must not assume a charge landed. A
  // counter rather than a throw: billing must not fail the customer's request,
  // and a log alone is too quiet to alert on.
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
      cause: last.cause,
      ...(last.status !== undefined ? { status: last.status } : {}),
      ...(last.errorName ? { errorName: last.errorName } : {}),
      ...(last.errorCode ? { errorCode: last.errorCode } : {}),
    },
  );
  firebillTrackTotal.labels(operation, outcome).inc();
  // Beside the outcome, never inside it: the alerts read `outcome` with
  // `increase()`, which evaluates per series, so a `cause` label on that counter
  // would quietly turn one threshold into one threshold per cause.
  firebillFailureCauseTotal.labels(operation, last.cause).inc();
  return false;
}

type AttemptResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * Kept as-is for `firebillRetryTotal`, plus `ambiguous` for the answer
       * firebill did not used to be able to give.
       */
      reason: "not_ok" | "not_success" | "ambiguous" | "exception";
      /** Who failed. See {@link FirebillCause}. */
      cause: FirebillCause;
      status?: number;
      errorName?: string;
      errorCode?: string;
    };

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

    const context = { customerId, entityId, featureId, value, path };

    if (!response.ok) {
      const body = await readJson(response);
      if (saysAmbiguous(response.status, body)) {
        logger.warn("firebill did not know whether it took the event", {
          ...context,
          status: response.status,
        });
        return {
          ok: false,
          reason: "ambiguous",
          cause: "ambiguous",
          status: response.status,
        };
      }
      logger.warn(
        "firebill track attempt failed — firebill answered a non-OK status",
        {
          ...context,
          status: response.status,
        },
      );
      return {
        ok: false,
        reason: "not_ok",
        cause: "non_ok",
        status: response.status,
      };
    }

    const body = await readJson(response);
    // Belt and braces: a 200 that still says it does not know is not a refusal.
    if (saysAmbiguous(response.status, body)) {
      logger.warn("firebill did not know whether it took the event", context);
      return { ok: false, reason: "ambiguous", cause: "ambiguous" };
    }
    // **Only `success: false` is a refusal.** It is the one answer that is proof
    // the event is gone, and it is what the `refused` alert means. A body we
    // could not read, or one with no `success` in it, may well be firebill
    // telling us it took the event in a shape we did not understand — so it is
    // ambiguous, and the caller retries under the same key rather than logging
    // usage as lost.
    const parsed =
      body === UNUSABLE_BODY ? undefined : usageAnswerSchema.safeParse(body);
    if (parsed?.success && parsed.data.success === false) {
      logger.warn("firebill refused the event — it did not take it", context);
      return { ok: false, reason: "not_success", cause: "refused" };
    }
    if (!parsed?.success) {
      logger.warn("firebill answered with a body we could not read", {
        ...context,
        status: response.status,
      });
      return { ok: false, reason: "ambiguous", cause: "unusable" };
    }

    logger.info("firebill track succeeded", context);
    return { ok: true };
  } catch (error) {
    // DO NOT fall back to Autumn directly: firebill may have accepted the event
    // before this failed, and the Autumn SDK sends no idempotency key, so the
    // pair could not be deduped and the customer would be billed twice.
    const failure = classifyTransportError(error);
    // **Not "firebill may be unavailable".** The request never completed, which
    // says nothing about firebill: these are almost all our own 5s deadline
    // firing against a service whose server-side p99 is 73ms.
    logger.warn(
      "firebill track request did not complete — client-side timeout or connection error; firebill did not answer",
      {
        customerId,
        entityId,
        featureId,
        value,
        path,
        timeoutMs: FIREBILL_TIMEOUT_MS,
        ...failure,
        error,
      },
    );
    return { ok: false, reason: "exception", ...failure };
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
  // `reason` is always a literal from the call sites below, so the rendered
  // message stays a closed set that log search can group on; anything variable
  // goes in `extra`.
  const unavailable = (
    reason: string,
    cause: FirebillCause,
    extra?: Record<string, unknown>,
  ): FirebillCheckResult => {
    logger.error(`firebill check unavailable — ${reason}`, {
      customerId,
      entityId,
      featureId,
      value,
      cause,
      ...extra,
    });
    firebillCheckTotal.labels("unavailable").inc();
    firebillFailureCauseTotal.labels("check", cause).inc();
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
      // `readJson` releases the socket whatever the body turns out to be.
      // Returning without reading or cancelling leaves it unconsumed, and
      // undici keeps the connection pinned until it is — so a firebill that is
      // erroring would exhaust the pool and turn one failure into a run of
      // them. Matters most here: this path is the one that fails open, so the
      // leak would be silently widening the window in which credit checks are
      // skipped.
      const errorBody = await readJson(response);
      return unavailable(
        "firebill answered a non-OK status",
        saysAmbiguous(response.status, errorBody) ? "ambiguous" : "non_ok",
        { status: response.status },
      );
    }

    const answered = await readJson(response);
    if (answered === UNUSABLE_BODY) {
      return unavailable("answered with a body we could not read", "unusable", {
        status: response.status,
      });
    }

    const parsed = checkAnswerSchema.safeParse(answered);
    // Unreadable, not refused: a missing `success` or a mis-shaped `allowed` read
    // as a denial would 402 a paying customer, and counting it `refused` would
    // have anyone slicing by cause counting it a decline. So it fails open.
    if (!parsed.success) {
      return unavailable("answered without a usable shape", "unusable");
    }
    // `success: false` is firebill saying it does not know — an unanswered
    // balance, or a gateway lookup that failed. Never a denial.
    if (parsed.data.success === false) {
      return unavailable("firebill could not answer", "refused");
    }
    const body = parsed.data;

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
    const failure = classifyTransportError(error);
    // **Not "firebill is unavailable".** The request never completed, which is
    // a statement about this process's socket, DNS or deadline — not about
    // firebill, which never got the chance to answer.
    return unavailable(
      "the request did not complete (client-side timeout or connection error); firebill did not answer",
      failure.cause,
      { timeoutMs: FIREBILL_TIMEOUT_MS, ...failure, error },
    );
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

    const context = { customerId, entityId, featureId, value, lockId };

    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      logger.error("firebill lock failed — firebill answered a non-OK status", {
        ...context,
        status: response.status,
      });
      firebillFailureCauseTotal.labels("lock", "non_ok").inc();
      return { status: "unavailable" };
    }

    const answered = await readJson(response);
    // An answer we could not parse is firebill answering, not the network
    // failing — so it must not fall through to the transport catch below and be
    // reported as a connection error.
    if (answered === UNUSABLE_BODY) {
      logger.error("firebill lock answered with a body we could not read", {
        ...context,
        status: response.status,
      });
      firebillFailureCauseTotal.labels("lock", "unusable").inc();
      return { status: "unavailable" };
    }
    const parsed = lockAnswerSchema.safeParse(answered);
    // Both proceed unlocked, but the cause has to tell them apart: an explicit
    // `success: false` is `refused`, a shape matching neither arm is `unusable`.
    if (!parsed.success || parsed.data.success === false) {
      logger.error("firebill lock did not succeed", context);
      firebillFailureCauseTotal
        .labels("lock", parsed.success ? "refused" : "unusable")
        .inc();
      return { status: "unavailable" };
    }
    const body = parsed.data;

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

    // allowed is a schema-guaranteed boolean and the denial above took the
    // false, so this is allowed: true.
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
    const failure = classifyTransportError(error);
    logger.error(
      "firebill lock request did not complete — client-side timeout or connection error; firebill did not answer",
      {
        customerId,
        entityId,
        featureId,
        value,
        lockId,
        timeoutMs: partnerJobToken
          ? FIREBILL_GATED_LOCK_TIMEOUT_MS
          : FIREBILL_TIMEOUT_MS,
        ...failure,
        error,
      },
    );
    firebillFailureCauseTotal.labels("lock", failure.cause).inc();
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
  featureId,
  heldValue,
}: {
  lockId: string;
  action: "confirm" | "release";
  overrideValue?: number;
  properties?: Record<string, unknown>;
  externalRequestId?: string | null;
  customerId?: string | null;
  featureId?: string | null;
  heldValue?: number | null;
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
        // With customer_id, this is what lets firebill split the settle across
        // the ghost and its funder — it reads what the ghost has left of this
        // feature. Without it the whole cost falls on the ghost.
        ...(featureId ? { feature_id: featureId } : {}),
        // What the lock reserved. Autumn reports a balance net of outstanding
        // holds, so firebill needs this to know what the ghost can actually
        // pay for this run; without it the whole cost falls on the ghost.
        ...(heldValue !== undefined && heldValue !== null
          ? { held_value: heldValue }
          : {}),
      }),
      signal: AbortSignal.timeout(FIREBILL_TIMEOUT_MS),
    });

    const context = { lockId, action, overrideValue };

    if (!response.ok) {
      const errorBody = await readJson(response);
      // A settle firebill did not know it took is not a settle it refused. The
      // finalize contract is a boolean either way — the schedule is what
      // retries — but the log has to say which happened.
      const ambiguous = saysAmbiguous(response.status, errorBody);
      logger.error(
        ambiguous
          ? "firebill did not know whether it took the settle"
          : "firebill finalize failed — firebill answered a non-OK status",
        { ...context, status: response.status },
      );
      firebillFailureCauseTotal
        .labels("finalize", ambiguous ? "ambiguous" : "non_ok")
        .inc();
      return false;
    }

    const answered = await readJson(response);
    // Answered but unreadable, which is not the network failing — the transport
    // catch below must not claim it was.
    if (answered === UNUSABLE_BODY) {
      logger.error("firebill finalize answered with a body we could not read", {
        ...context,
        status: response.status,
      });
      firebillFailureCauseTotal.labels("finalize", "unusable").inc();
      return false;
    }
    const parsed = usageAnswerSchema.safeParse(answered);
    if (!parsed.success || parsed.data.success !== true) {
      logger.error("firebill finalize did not succeed", context);
      firebillFailureCauseTotal
        // Explicit `success: false` is `refused`; an unreadable shape `unusable`.
        .labels("finalize", parsed.success ? "refused" : "unusable")
        .inc();
      return false;
    }

    logger.info("firebill finalize succeeded", context);
    return true;
  } catch (error) {
    const failure = classifyTransportError(error);
    logger.error(
      "firebill finalize request did not complete — client-side timeout or connection error; firebill did not answer",
      {
        lockId,
        action,
        overrideValue,
        timeoutMs: FIREBILL_TIMEOUT_MS,
        ...failure,
        error,
      },
    );
    firebillFailureCauseTotal.labels("finalize", failure.cause).inc();
    return false;
  }
}
