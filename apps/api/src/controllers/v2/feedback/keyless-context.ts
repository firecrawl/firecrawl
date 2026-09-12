import { config } from "../../../config";
import { keylessTeamUuid } from "../../../lib/keyless";
import { getScrapeZDR, getSearchZDR } from "../../../lib/zdr-helpers";
import { redisRateLimitClient } from "../../../services/rate-limiter";
import { logger } from "../../../lib/logger";
import { keylessFeedbackRedis } from "./keyless-redis";
import type { RequestWithAuth } from "../types";
import type { KeylessFeedbackEndpoint } from "./keyless-schema";
import { hasKeylessFeedbackToday } from "./keyless-store";
import { snapshotCopier } from "./keyless-snapshot";
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
  requestedSources?: string[];
  requestedFormats?: string[];
};

export function requestedTypes(value: unknown, defaultType: string): string[] {
  if (!Array.isArray(value)) return [defaultType];
  return [
    ...new Set(
      value
        .map(item => (typeof item === "string" ? item : item?.type))
        .filter((type): type is string => typeof type === "string"),
    ),
  ];
}

function resultContext(
  endpoint: KeylessFeedbackEndpoint,
  result: any,
): unknown {
  const snapshot = snapshotCopier(24 * 1024);
  if (endpoint === "search") {
    const groups = Object.fromEntries(
      (["web", "images", "news"] as const).map(source => [
        source,
        (result?.[source] ?? [])
          .slice(0, 100)
          .map((item: any, index: number) => ({
            position: index + 1,
            category:
              typeof item.category === "string"
                ? item.category.slice(0, 100)
                : undefined,
            ...snapshot.copy({
              url: item.url,
              title: item.title,
              description: item.description,
              snippet: item.snippet,
              imageUrl: item.imageUrl,
            }),
          })),
      ]),
    );
    return { ...groups, ...(snapshot.truncated ? { truncated: true } : {}) };
  }
  const value = snapshot.copy(result ?? null);
  return snapshot.truncated ? { ...value, truncated: true } : value;
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
  const reference: Record<string, unknown> = { jobId };
  const key = keylessFeedbackContextKey(identity, endpoint, jobId);
  try {
    const metadata = await Promise.race([
      (async () => {
        const options = snapshotCopier(16 * 1024);
        const request = options.copy(req.body);
        context = {
          createdAt: new Date().toISOString(),
          success,
          // Preserve validation identifiers independently of snapshot truncation.
          ...(endpoint === "search"
            ? { requestedSources: requestedTypes(req.body?.sources, "web") }
            : {
                requestedFormats: requestedTypes(req.body?.formats, "markdown"),
              }),
          invited: false,
          request: options.truncated
            ? { ...request, truncated: true }
            : request,
          result: resultContext(endpoint, result),
        };
        const encoded = JSON.stringify(context);
        if (Buffer.byteLength(encoded) > 64 * 1024) return reference;
        await cache.set(key, encoded, "EX", KEYLESS_FEEDBACK_MAX_AGE_SEC);
        const metadata: Record<string, unknown> = reference;
        const every = config.KEYLESS_FEEDBACK_INVITATION_EVERY;
        if (expired || !every || (endpoint === "scrape" && !success))
          return metadata;
        const count = Number(
          await cache.eval(
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
    logger.warn("Keyless feedback context unavailable", {
      canonicalLog: "keyless/feedback_context_error",
      endpoint,
      jobId,
    });
    return reference;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
