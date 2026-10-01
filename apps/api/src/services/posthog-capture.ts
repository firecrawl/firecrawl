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

export function capturePostHog(
  event: string,
  distinctId: string,
  properties: Record<string, unknown> = {},
): void {
  if (!POSTHOG_API_KEY) return;

  // Fire-and-forget — do not await in the request path, never throw.
  void (async () => {
    try {
      await fetch(`${POSTHOG_HOST.replace(/\/$/, "")}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: POSTHOG_API_KEY,
          event,
          distinct_id: distinctId,
          properties,
        }),
      });
    } catch (error) {
      _logger.debug("PostHog capture failed", {
        module: "posthog",
        event,
        error,
      });
    }
  })();
}
