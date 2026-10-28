import { logger as _logger } from "../lib/logger";
import { redisEvictConnection } from "./redis";
import {
  capturePostHog,
  evaluatePostHogFlag,
  isPostHogCaptureEnabled,
} from "./posthog-capture";
import { resolveDistinctId } from "./posthog";
import type { RateLimitExperimentVariant } from "./rate-limiter";

/**
 * PostHog experiment for the per-minute minimums in services/rate-limiter.ts.
 * The flag is org-level (aggregated on the `company` group, key = org id) with
 * `control` and `treatment` variants and no targeting conditions. PostHog
 * assigns the variant; eligibility (a limit the variant can change) lives in
 * code, so the flag is only read for eligible requests.
 */
const RATE_LIMIT_EXPERIMENT_FLAG = "higher-rate-limits";

const VARIANTS: ReadonlySet<string> = new Set(["control", "treatment"]);

/**
 * How long a stored assignment is trusted. After that it still serves while
 * it is re-read in the background, so pausing or ending the experiment in
 * PostHog reaches every org within about this long, and only a lookup with
 * no stored answer waits on PostHog.
 */
const ASSIGNMENT_FRESH_MS = 60 * 60 * 1000;
const ASSIGNMENT_TTL_SECONDS = 7 * 24 * 60 * 60;

// Per-process copy of the stored assignment, so most requests skip Redis. A
// transient PostHog failure is held here too, so it is retried a minute later
// rather than on every request.
const LOCAL_TTL_MS = 60 * 1000;
const LOCAL_MAX_ENTRIES = 100_000;

// The stored assignment is read in the auth path, so a read that takes longer
// treats Redis as unavailable rather than holding the request.
const REDIS_READ_TIMEOUT_MS = 100;

// An exposure marker is short-lived until PostHog accepts the event, so one a
// failed send leaves behind expires and the exposure is retried. An expired
// marker only resends an exposure PostHog already counts once per person and
// variant.
const EXPOSURE_PENDING_TTL_SECONDS = 5 * 60;
const EXPOSURE_TTL_SECONDS = 30 * 24 * 60 * 60;

type Assignment = {
  /** Null when PostHog assigns no variant: flag off, paused or ended. */
  variant: RateLimitExperimentVariant | null;
  checkedAt: number;
};

type ExperimentCaller = {
  orgId: string;
  teamId: string;
  /** The exact decimal id when known, as bigint ids can pass the safe range. */
  apiKeyId?: string | number | null;
  /**
   * The team's plan when the exposure is sent. An org's first exposure, sent
   * when it enrolls, so carries the plan it started on.
   */
  rateLimitMultiplier: number;
  isPaidPlan: boolean;
};

const localAssignments = new Map<
  string,
  { assignment: Assignment | undefined; until: number }
>();
const pendingAssignments = new Map<string, Promise<Assignment | undefined>>();
// Exposures not to send again before the time stored here: forever once this
// process sent one, for a pending marker's lifetime after another process held
// the marker or PostHog rejected the event.
const skipExposureUntil = new Map<string, number>();
const pendingExposures = new Set<string>();

const assignmentKey = (orgId: string) =>
  `firecrawl:rate_limit_experiment:${orgId}`;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Redis did not answer in time")),
        ms,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= LOCAL_MAX_ENTRIES) map.clear();
  map.set(key, value);
}

// Redis did not answer, so whether the org has a stored assignment is unknown.
const STORE_UNAVAILABLE = Symbol("store-unavailable");

async function readAssignment(
  orgId: string,
): Promise<Assignment | undefined | typeof STORE_UNAVAILABLE> {
  let raw: string | null;
  try {
    raw = await withTimeout(
      redisEvictConnection.get(assignmentKey(orgId)),
      REDIS_READ_TIMEOUT_MS,
    );
  } catch {
    return STORE_UNAVAILABLE;
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Assignment> | null;
    // Anything else, e.g. a variant this code no longer knows, is a miss.
    if (
      typeof parsed?.checkedAt !== "number" ||
      (parsed.variant !== null &&
        (typeof parsed.variant !== "string" || !VARIANTS.has(parsed.variant)))
    ) {
      return undefined;
    }
    return { variant: parsed.variant, checkedAt: parsed.checkedAt };
  } catch {
    return undefined;
  }
}

/**
 * Read the org's variant from PostHog and store it. Undefined on a transient
 * failure, which is not stored. Concurrent calls for an org share one read.
 */
function fetchAssignment(
  caller: ExperimentCaller,
): Promise<Assignment | undefined> {
  const pending = pendingAssignments.get(caller.orgId);
  if (pending) return pending;

  const promise = (async () => {
    try {
      // The flag buckets on the company group, so the distinct id does not
      // decide the variant, and the org id keeps a DB read out of this path.
      const result = await evaluatePostHogFlag(
        RATE_LIMIT_EXPERIMENT_FLAG,
        caller.orgId,
        { company: caller.orgId },
      );
      if (result.status === "retryable") return undefined;
      // A variant key PostHog serves but code doesn't know (e.g. mistyped in
      // the UI) enrolls nobody, like a flag that is off.
      const variant =
        result.status === "resolved" && VARIANTS.has(result.variant)
          ? (result.variant as RateLimitExperimentVariant)
          : null;
      const assignment: Assignment = { variant, checkedAt: Date.now() };
      // Not awaited, so a stalled Redis never holds the request. A failed
      // store still serves the answer; the per-process copy holds it and the
      // next lookup after that asks PostHog again.
      void redisEvictConnection
        .set(
          assignmentKey(caller.orgId),
          JSON.stringify(assignment),
          "EX",
          ASSIGNMENT_TTL_SECONDS,
        )
        .catch(error => {
          _logger.debug("Rate-limit experiment assignment not stored", {
            module: "rate-limit-experiment",
            orgId: caller.orgId,
            error,
          });
        });
      return assignment;
    } catch (error) {
      _logger.debug("Rate-limit experiment assignment failed", {
        module: "rate-limit-experiment",
        orgId: caller.orgId,
        error,
      });
      return undefined;
    } finally {
      pendingAssignments.delete(caller.orgId);
    }
  })();
  pendingAssignments.set(caller.orgId, promise);
  return promise;
}

function refreshAssignment(caller: ExperimentCaller): void {
  void fetchAssignment(caller).then(fresh => {
    if (fresh) {
      setBounded(localAssignments, caller.orgId, {
        assignment: fresh,
        until: Date.now() + LOCAL_TTL_MS,
      });
    }
  });
}

async function getAssignment(
  caller: ExperimentCaller,
): Promise<Assignment | undefined> {
  const local = localAssignments.get(caller.orgId);
  if (local && local.until > Date.now()) return local.assignment;

  const stored = await readAssignment(caller.orgId);
  let assignment: Assignment | undefined;
  if (stored === STORE_UNAVAILABLE) {
    // The org may well have a stored assignment, so keep this process's last
    // answer rather than wait on PostHog, and ask it in the background.
    assignment = local?.assignment;
    refreshAssignment(caller);
  } else if (!stored) {
    // No stored answer yet, e.g. the org's first request: the only case that
    // waits on PostHog.
    assignment = await fetchAssignment(caller);
  } else {
    assignment = stored;
    if (Date.now() - stored.checkedAt > ASSIGNMENT_FRESH_MS) {
      refreshAssignment(caller);
    }
  }
  setBounded(localAssignments, caller.orgId, {
    assignment,
    until: Date.now() + LOCAL_TTL_MS,
  });
  return assignment;
}

/**
 * Send the experiment exposure, `$feature_flag_called` with the variant, once
 * per (org, variant) while its marker lasts (EXPOSURE_TTL_SECONDS), the same
 * event the web app's server-resolved experiments send. An org moved to the
 * other variant is reported again, and PostHog excludes it as a multiple
 * exposure. Fire-and-forget; never throws.
 */
function trackExposure(
  caller: ExperimentCaller,
  variant: RateLimitExperimentVariant,
): void {
  const marker = `${caller.orgId}:${variant}`;
  if ((skipExposureUntil.get(marker) ?? 0) > Date.now()) return;
  if (pendingExposures.has(marker)) return;
  pendingExposures.add(marker);

  void (async () => {
    try {
      const key = `firecrawl:rate_limit_experiment_exposure:${marker}`;
      const isFirst = await redisEvictConnection.set(
        key,
        "1",
        "EX",
        EXPOSURE_PENDING_TTL_SECONDS,
        "NX",
      );
      if (isFirst !== "OK") {
        // Another process holds the marker. Check again once a pending marker
        // would have expired, in case that process's send failed.
        setBounded(
          skipExposureUntil,
          marker,
          Date.now() + EXPOSURE_PENDING_TTL_SECONDS * 1000,
        );
        return;
      }
      const distinctId = await resolveDistinctId(
        caller.teamId,
        caller.apiKeyId,
      );
      const sent = await capturePostHog("$feature_flag_called", distinctId, {
        $feature_flag: RATE_LIMIT_EXPERIMENT_FLAG,
        $feature_flag_response: variant,
        team_id: caller.teamId,
        rate_limit_multiplier: caller.rateLimitMultiplier,
        is_paid_plan: caller.isPaidPlan,
        $groups: { company: caller.orgId, team: caller.teamId },
      });
      if (sent) {
        setBounded(skipExposureUntil, marker, Number.POSITIVE_INFINITY);
        // Best effort: if this fails, the pending marker expires and another
        // process may resend an exposure PostHog already counted once.
        await redisEvictConnection
          .expire(key, EXPOSURE_TTL_SECONDS)
          .catch(error => {
            _logger.debug(
              "Rate-limit experiment exposure marker not extended",
              {
                module: "rate-limit-experiment",
                orgId: caller.orgId,
                error,
              },
            );
          });
      } else {
        // A rejected capture must not use up the exposure, but is not retried
        // on every request while PostHog keeps rejecting it.
        setBounded(
          skipExposureUntil,
          marker,
          Date.now() + EXPOSURE_PENDING_TTL_SECONDS * 1000,
        );
        await redisEvictConnection.del(key);
      }
    } catch (error) {
      _logger.debug("Rate-limit experiment exposure failed", {
        module: "rate-limit-experiment",
        orgId: caller.orgId,
        error,
      });
    } finally {
      pendingExposures.delete(marker);
    }
  })();
}

/**
 * The org's rate-limit experiment variant, reported to PostHog as an exposure
 * the first time it is seen. Undefined when the org is not enrolled: PostHog
 * capture is off, the flag is off or unreachable, or the variant is unknown;
 * the caller then keeps the current limits. Call it only for a request whose
 * limit the variant changes (see rateLimitExperimentApplies), once the request
 * has passed the auth checks.
 */
export async function getRateLimitExperimentVariant(
  caller: ExperimentCaller,
): Promise<RateLimitExperimentVariant | undefined> {
  if (!isPostHogCaptureEnabled() || !caller.orgId) return undefined;
  const variant = (await getAssignment(caller))?.variant ?? undefined;
  if (variant !== undefined) trackExposure(caller, variant);
  return variant;
}
