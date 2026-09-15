import { config } from "../../../config";
import { keylessTeamUuid } from "../../../lib/keyless";
import { redisRateLimitClient } from "../../../services/rate-limiter";
import { logger } from "../../../lib/logger";
import type { RequestWithAuth } from "../types";
import type { KeylessFeedbackEndpoint } from "./keyless-schema";
import { hasKeylessFeedbackToday } from "./keyless-store";
import { isKeylessFeedbackRestricted } from "./zdr-persistence";
import {
  KEYLESS_FEEDBACK_ATTEMPTS,
  KEYLESS_FEEDBACK_MAX_AGE_SEC,
  keylessFeedbackAttemptKey,
} from "./keyless-limits";

export async function keylessFeedbackMetadata(
  req: RequestWithAuth<any, any, any>,
  endpoint: KeylessFeedbackEndpoint,
  jobId: string,
  success: boolean,
): Promise<Record<string, unknown>> {
  const identity = keylessTeamUuid(req.auth.team_id);
  if (!identity) return {};
  const reference: Record<string, unknown> = { jobId };
  if (
    !config.KEYLESS_FEEDBACK_ENABLED ||
    !config.USE_DB_AUTHENTICATION ||
    req.acuc?.flags?.searchFeedbackOptOut ||
    isKeylessFeedbackRestricted(endpoint, req.body, req.acuc?.flags)
  )
    return reference;

  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  try {
    const metadata = await Promise.race([
      (async () => {
        const metadata = reference;
        const every = config.KEYLESS_FEEDBACK_INVITATION_EVERY;
        if (expired || !every || (endpoint === "scrape" && !success))
          return metadata;
        const count = Number(
          await redisRateLimitClient.eval(
            `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 86400) end
return count
`,
            1,
            `keyless_feedback_invitations:${identity}`,
          ),
        );
        if (expired || count % every !== 0) return metadata;
        if (
          Number(
            await redisRateLimitClient.get(keylessFeedbackAttemptKey(identity)),
          ) >= KEYLESS_FEEDBACK_ATTEMPTS ||
          (await hasKeylessFeedbackToday(identity))
        )
          return metadata;
        return {
          ...metadata,
          feedback: {
            endpoint,
            jobId,
            method: "POST",
            path: "/v2/feedback",
            expiresAt: new Date(
              Date.now() + KEYLESS_FEEDBACK_MAX_AGE_SEC * 1000,
            ).toISOString(),
            message:
              "Optional: submit your task, rating, assessment, and specific observations. Use only evidence already available; distinguish output, source comparisons, and expectations. No additional investigation is required. One accepted submission per keyless identity per UTC day, shared across Search, Scrape, Parse, and all clients.",
          },
        };
      })(),
      new Promise<Record<string, unknown>>(resolve => {
        timer = setTimeout(() => {
          expired = true;
          resolve(reference);
        }, 250);
      }),
    ]);
    if (metadata.feedback) {
      // A timeout or disconnected response must not count as an invitation.
      req.res?.once("finish", () => {
        logger.info("Keyless feedback invitation issued", {
          canonicalLog: "keyless/feedback_invitation",
          invited: true,
          issuedAt: new Date().toISOString(),
          identity,
          endpoint,
          jobId,
          origin:
            typeof req.body?.origin === "string"
              ? req.body.origin.slice(0, 100)
              : "api",
          integration:
            typeof req.body?.integration === "string"
              ? req.body.integration.slice(0, 100)
              : null,
        });
      });
    }
    return metadata;
  } catch {
    logger.warn("Keyless feedback invitation unavailable", {
      canonicalLog: "keyless/feedback_invitation_error",
      endpoint,
      jobId,
    });
    return reference;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
