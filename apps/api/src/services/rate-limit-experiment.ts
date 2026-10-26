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
 * PostHog reaches every org within about this long, and no request waits on
 * PostHog after an org's first.
 */
const ASSIGNMENT_FRESH_MS = 60 * 60 * 1000;
const ASSIGNMENT_TTL_SECONDS = 7 * 24 * 60 * 60;

// Per-process copy of the stored assignment, so most requests skip Redis. A
// transient PostHog failure is held here too, so it is retried a minute later
// rather than on every request.
const LOCAL_TTL_MS = 60 * 1000;
const LOCAL_MAX_ENTRIES = 100_000;

// An expired exposure marker only resends an exposure PostHog already counts
// once per person and variant.
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
};

const localAssignments = new Map<
  string,
  { assignment: Assignment | undefined; until: number }
>();
const pendingAssignments = new Map<string, Promise<Assignment | undefined>>();
const reportedExposures = new Set<string>();
const pendingExposures = new Set<string>();

const assignmentKey = (orgId: string) =>
  `firecrawl:rate_limit_experiment:${orgId}`;

function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= LOCAL_MAX_ENTRIES) map.clear();
  map.set(key, value);
}

async function readAssignment(orgId: string): Promise<Assignment | undefined> {
  try {
    const raw = await redisEvictConnection.get(assignmentKey(orgId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Assignment;
    return typeof parsed.checkedAt === "number" ? parsed : undefined;
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
      const distinctId = await resolveDistinctId(
        caller.teamId,
        caller.apiKeyId,
      );
      const result = await evaluatePostHogFlag(
        RATE_LIMIT_EXPERIMENT_FLAG,
        distinctId,
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
      await redisEvictConnection.set(
        assignmentKey(caller.orgId),
        JSON.stringify(assignment),
        "EX",
        ASSIGNMENT_TTL_SECONDS,
      );
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

async function getAssignment(
  caller: ExperimentCaller,
): Promise<Assignment | undefined> {
  const local = localAssignments.get(caller.orgId);
  if (local && local.until > Date.now()) return local.assignment;

  let assignment = await readAssignment(caller.orgId);
  if (!assignment) {
    // First request from this org: the only one that waits on PostHog.
    assignment = await fetchAssignment(caller);
  } else if (Date.now() - assignment.checkedAt > ASSIGNMENT_FRESH_MS) {
    void fetchAssignment(caller).then(fresh => {
      if (fresh) {
        setBounded(localAssignments, caller.orgId, {
          assignment: fresh,
          until: Date.now() + LOCAL_TTL_MS,
        });
      }
    });
  }
  setBounded(localAssignments, caller.orgId, {
    assignment,
    until: Date.now() + LOCAL_TTL_MS,
  });
  return assignment;
}

/**
 * Send the experiment exposure, `$feature_flag_called` with the variant, at
 * most once per (org, variant), the same event the web app's server-resolved
 * experiments send. An org moved to the other variant is reported again, and
 * PostHog excludes it as a multiple exposure. Fire-and-forget; never throws.
 */
function trackExposure(
  caller: ExperimentCaller,
  variant: RateLimitExperimentVariant,
): void {
  const marker = `${caller.orgId}:${variant}`;
  if (reportedExposures.has(marker) || pendingExposures.has(marker)) return;
  pendingExposures.add(marker);

  void (async () => {
    try {
      const key = `firecrawl:rate_limit_experiment_exposure:${marker}`;
      const isFirst = await redisEvictConnection.set(
        key,
        "1",
        "EX",
        EXPOSURE_TTL_SECONDS,
        "NX",
      );
      if (isFirst !== "OK") {
        // Another process holds the marker. If its capture fails, it releases
        // the marker and retries on its own next request.
        reportedExposures.add(marker);
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
        $groups: { company: caller.orgId, team: caller.teamId },
      });
      if (sent) {
        if (reportedExposures.size >= LOCAL_MAX_ENTRIES) {
          reportedExposures.clear();
        }
        reportedExposures.add(marker);
      } else {
        // A rejected capture must not use up the exposure.
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
