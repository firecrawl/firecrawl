import { config } from "../../../config";
import { keylessTeamUuid } from "../../../lib/keyless";
import { getScrapeZDR, getSearchZDR } from "../../../lib/zdr-helpers";
import { redisRateLimitClient } from "../../../services/rate-limiter";
import { logger } from "../../../lib/logger";
import { keylessFeedbackRedis } from "./keyless-redis";
import type { RequestWithAuth } from "../types";
import type { KeylessFeedbackEndpoint } from "./keyless-schema";
import { hasKeylessFeedbackToday } from "./keyless-store";
import {
  KEYLESS_FEEDBACK_ATTEMPTS,
  keylessFeedbackAttemptKey,
} from "./keyless-limits";

export const KEYLESS_FEEDBACK_MAX_AGE_SEC = 86400;
export const keylessFeedbackContextKey = (
  identity: string,
  endpoint: string,
  jobId: string,
) => `keyless_feedback_context:${identity}:${endpoint}:${jobId}`;

export type KeylessFeedbackContext = {
  createdAt: string;
  success: boolean;
  invited: boolean;
  request: unknown;
  result: unknown;
};

function redactOptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/headers|cookie|token|secret|password|authorization|api.?key|^uploadref$|^buffer$|base64|^__/.test(
            key.toLowerCase(),
          ),
      )
      .map(([key, item]) => [key, redactOptions(item)]),
  );
}

function resultContext(
  endpoint: KeylessFeedbackEndpoint,
  result: any,
): unknown {
  if (endpoint === "search") {
    return Object.fromEntries(
      (["web", "images", "news"] as const).map(source => [
        source,
        (result?.[source] ?? []).map((item: any, index: number) => ({
          position: index + 1,
          url: item.url,
          title: item.title,
          description: item.description,
          category: item.category,
          snippet: item.snippet,
          imageUrl: item.imageUrl,
        })),
      ]),
    );
  }
  const text = JSON.stringify(result ?? null);
  return text.length <= 16000
    ? result
    : { excerpt: text.slice(0, 16000), truncated: true };
}

export async function keylessFeedbackMetadata(
  req: RequestWithAuth<any, any, any>,
  endpoint: KeylessFeedbackEndpoint,
  jobId: string,
  success: boolean,
  result: unknown,
): Promise<Record<string, unknown>> {
  const identity = keylessTeamUuid(req.auth.team_id);
  const cache = keylessFeedbackRedis;
  if (
    !identity ||
    !cache ||
    !config.KEYLESS_FEEDBACK_ENABLED ||
    !config.USE_DB_AUTHENTICATION ||
    req.acuc?.flags?.searchFeedbackOptOut ||
    req.body?.zeroDataRetention ||
    req.body?.lockdown ||
    req.body?.enterprise?.includes("zdr") ||
    getScrapeZDR(req.acuc?.flags) === "forced" ||
    getSearchZDR(req.acuc?.flags) === "forced-zdr"
  )
    return {};

  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  let context: KeylessFeedbackContext | undefined;
  const key = keylessFeedbackContextKey(identity, endpoint, jobId);
  try {
    const metadata = await Promise.race([
      (async () => {
        context = {
          createdAt: new Date().toISOString(),
          success,
          invited: false,
          request: redactOptions(req.body),
          result: resultContext(endpoint, result),
        };
        const encoded = JSON.stringify(context);
        if (Buffer.byteLength(encoded) > 64 * 1024) return {};
        await cache.set(key, encoded, "EX", KEYLESS_FEEDBACK_MAX_AGE_SEC);
        const metadata: Record<string, unknown> = { jobId };
        const every = config.KEYLESS_FEEDBACK_INVITATION_EVERY;
        if (
          expired ||
          !every ||
          req.headers?.["x-firecrawl-no-feedback"] === "1"
        )
          return metadata;
        const count = Number(
          await cache.eval(
            `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 86400) end
return count
`,
            1,
            `keyless_feedback_invitations:${identity}:${endpoint}`,
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
          resolve({});
        }, 250);
      }),
    ]);
    if (metadata.feedback && context) {
      const issuedContext = { ...context, invited: true };
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
        // Keep the original expiry and never recreate an evicted context.
        void cache
          .set(key, JSON.stringify(issuedContext), "KEEPTTL", "XX")
          .catch(() => {
            logger.warn("Keyless feedback invitation context update failed", {
              canonicalLog: "keyless/feedback_invitation_context_error",
              endpoint,
              jobId,
            });
          });
      });
    }
    return metadata;
  } catch {
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}
