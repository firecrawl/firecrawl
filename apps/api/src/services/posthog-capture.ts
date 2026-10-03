import { logger as _logger } from "../lib/logger";

/**
 * Lightweight, dependency-free PostHog capture for the API.
 *
 * The API has no PostHog SDK wired up, so we POST directly to the capture
 * endpoint. Everything here is best-effort and fire-and-forget: a missing key
 * or a network error must never affect request handling.
 *
 * Configure via env:
 *   POSTHOG_API_KEY  — project API key (if unset, capture is a no-op)
 *   POSTHOG_HOST     — ingestion host (defaults to https://us.i.posthog.com)
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
