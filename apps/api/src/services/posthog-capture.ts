import { logger as _logger } from "../lib/logger";

/**
 * Lightweight, dependency-free PostHog capture and flag evaluation for the API.
 *
 * The API has no PostHog SDK wired up, so we POST directly to the capture and
 * flags endpoints. Everything here is best-effort: a missing key or a network
 * error must never affect request handling.
 *
 * Configure via env:
 *   POSTHOG_API_KEY: project API key (if unset, capture and flag reads are
 *                    no-ops)
 *   POSTHOG_HOST:    ingestion host (defaults to https://us.i.posthog.com)
 */
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

/**
 * False when capture is a no-op. Callers that spend a dedup marker check this
 * first, so the marker is not burned while PostHog is off.
 */
export function isPostHogCaptureEnabled(): boolean {
  return Boolean(POSTHOG_API_KEY);
}

/**
 * Send one event. Resolves true when PostHog accepted it, false on a non-2xx
 * answer, a network error, or no key; never rejects. Callers that hold a dedup
 * marker release it on false. Do not await it in the request path.
 */
export async function capturePostHog(
  event: string,
  distinctId: string,
  properties: Record<string, unknown> = {},
): Promise<boolean> {
  if (!POSTHOG_API_KEY) return false;

  try {
    const response = await fetch(
      `${POSTHOG_HOST.replace(/\/$/, "")}/capture/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: POSTHOG_API_KEY,
          event,
          distinct_id: distinctId,
          properties,
        }),
      },
    );
    if (response.ok) return true;
    _logger.debug("PostHog capture rejected", {
      module: "posthog",
      event,
      status: response.status,
    });
  } catch (error) {
    _logger.debug("PostHog capture failed", {
      module: "posthog",
      event,
      error,
    });
  }
  return false;
}

// Bounds the wait for a flag read, matching the server-side flag reads in
// firecrawl-web: a slow PostHog delays a request by at most this much.
const FLAG_TIMEOUT_MS = 500;

export type PostHogFlagResult =
  | { status: "resolved"; variant: string }
  /** Off, unknown, or not matched for this caller: a stable non-assignment. */
  | { status: "disabled" }
  /** A timeout, error or quota limit: transient, so callers retry later. */
  | { status: "retryable" };

/**
 * Evaluate one multivariate flag with PostHog's `/flags` endpoint. `groups`
 * carries the group keys of a group-aggregated flag, e.g. `{ company: orgId }`
 * for an org-level experiment. Never rejects.
 */
export async function evaluatePostHogFlag(
  key: string,
  distinctId: string,
  groups: Record<string, string> = {},
): Promise<PostHogFlagResult> {
  if (!POSTHOG_API_KEY) return { status: "disabled" };

  try {
    const response = await fetch(
      `${POSTHOG_HOST.replace(/\/$/, "")}/flags/?v=2`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: POSTHOG_API_KEY,
          distinct_id: distinctId,
          groups,
          flag_keys_to_evaluate: [key],
        }),
        signal: AbortSignal.timeout(FLAG_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      _logger.debug("PostHog flag evaluation rejected", {
        module: "posthog",
        key,
        status: response.status,
      });
      // Only rate limiting and server errors pass; any other rejection, e.g.
      // a wrong key or host, enrolls nobody like a flag that is off.
      return response.status === 429 || response.status >= 500
        ? { status: "retryable" }
        : { status: "disabled" };
    }
    const body = (await response.json()) as {
      flags?: Record<string, { enabled?: boolean; variant?: unknown }>;
      errorsWhileComputingFlags?: boolean;
      quotaLimited?: string[] | null;
    };
    if (body.errorsWhileComputingFlags || body.quotaLimited?.length) {
      return { status: "retryable" };
    }
    const flag = body.flags?.[key];
    if (flag?.enabled && typeof flag.variant === "string") {
      return { status: "resolved", variant: flag.variant };
    }
    return { status: "disabled" };
  } catch (error) {
    _logger.debug("PostHog flag evaluation failed", {
      module: "posthog",
      key,
      error,
    });
    return { status: "retryable" };
  }
}
