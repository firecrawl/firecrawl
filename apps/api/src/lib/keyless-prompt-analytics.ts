import { redisRateLimitClient } from "../services/rate-limiter";
import {
  capturePostHog,
  isPostHogCaptureEnabled,
} from "../services/posthog-capture";
import { logger } from "./logger";
import type {
  KeylessPromptReason,
  KeylessSignupSurface,
} from "./keyless-signup-link";

export const KEYLESS_PROMPT_SHOWN_EVENT = "keyless_prompt_shown";

// One UTC day plus an hour, so a marker outlives the day it is keyed on.
const DEDUPE_TTL_SECONDS = 25 * 60 * 60;

type KeylessPromptShown = {
  /** keylessTeamUuid of the caller: the user_onboarding.keyless_team_id join key. */
  keylessTeamId: string;
  surface: KeylessSignupSurface;
  reason: KeylessPromptReason;
  httpStatus: number;
  /** True when the prompt carried a /k/<token> link, false for the fallback link. */
  tokenLink: boolean;
};

export function keylessPromptDedupeKey(
  prompt: Pick<KeylessPromptShown, "keylessTeamId" | "surface" | "reason">,
  now: Date = new Date(),
): string {
  const day = now.toISOString().slice(0, 10);
  return `keyless_prompt_shown:${day}:${prompt.keylessTeamId}:${prompt.surface}:${prompt.reason}`;
}

/**
 * Emit `keyless_prompt_shown` at most once per (keyless team, surface, reason)
 * per UTC day. The dedup marker is a Redis SET NX, released when the capture
 * fails so a later prompt retries. Fire-and-forget: never
 * awaited in the request path, never throws.
 */
export function trackKeylessPromptShown(prompt: KeylessPromptShown): void {
  // Bail before the SET NX so a marker is not spent while capture is off.
  if (!isPostHogCaptureEnabled()) return;

  void (async () => {
    try {
      const key = keylessPromptDedupeKey(prompt);
      const first = await redisRateLimitClient.set(
        key,
        "1",
        "EX",
        DEDUPE_TTL_SECONDS,
        "NX",
      );
      if (first !== "OK") return;

      const sent = await capturePostHog(
        KEYLESS_PROMPT_SHOWN_EVENT,
        prompt.keylessTeamId,
        {
          keyless_team_id: prompt.keylessTeamId,
          surface: prompt.surface,
          reason: prompt.reason,
          http_status: prompt.httpStatus,
          link_type: prompt.tokenLink ? "token" : "fallback",
          // Keyless identities are per IP: do not create a person for each one.
          $process_person_profile: false,
        },
      );
      // Release the marker so the next prompt today retries the event.
      if (!sent) await redisRateLimitClient.del(key);
    } catch (error) {
      logger.debug("trackKeylessPromptShown failed", {
        module: "keyless-prompt-analytics",
        error,
      });
    }
  })();
}
