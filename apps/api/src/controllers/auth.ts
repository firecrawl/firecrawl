import { parseApi } from "../lib/parseApi";
import { config } from "../config";
import { getRateLimiter } from "../services/rate-limiter";
import { AuthResponse, NotificationType, RateLimiterMode } from "../types";
import {
  supabase_acuc_only_service,
  supabase_rr_service,
  supabase_service,
} from "../services/supabase";
import { withAuth } from "../lib/withAuth";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { sendNotification } from "../services/notification/email_notification";
import { logger } from "../lib/logger";
import { redlock } from "../services/redlock";
import { deleteKey, getValue } from "../services/redis";
import { setValue } from "../services/redis";
import { getRedisConnection } from "../services/queue-service";
import { validate } from "uuid";
import * as Sentry from "@sentry/node";
import { AuthCreditUsageChunk, AuthCreditUsageChunkFromTeam } from "./v1/types";

function normalizedApiIsUuid(potentialUuid: string): boolean {
  // Check if the string is a valid UUID
  return validate(potentialUuid);
}

// ============================================================================
// Generic ACUC Cache Infrastructure
// ============================================================================
// Internal functions that handle both api_key and team_id based cache operations.
// The public API (setCachedACUC, getACUC, etc.) remains unchanged.

type ACUCEntityType = "api_key" | "team";

interface ACUCEntityConfig {
  entityType: ACUCEntityType;
  cacheKeyPrefix: string;
  rpcFunctionName: string;
  rpcInputParamName: string;
}

const API_KEY_CONFIG: ACUCEntityConfig = {
  entityType: "api_key",
  cacheKeyPrefix: "acuc",
  rpcFunctionName: "auth_credit_usage_chunk_39",
  rpcInputParamName: "input_key",
};

const TEAM_CONFIG: ACUCEntityConfig = {
  entityType: "team",
  cacheKeyPrefix: "acuc_team",
  rpcFunctionName: "auth_credit_usage_chunk_39_from_team",
  rpcInputParamName: "input_team",
};

function buildCacheKey(
  entityConfig: ACUCEntityConfig,
  entityId: string,
  isExtract: boolean,
): string {
  return `${entityConfig.cacheKeyPrefix}_${entityId}_${isExtract ? "extract" : "scrape"}`;
}

function buildBaseCacheKey(
  entityConfig: ACUCEntityConfig,
  entityId: string,
): string {
  return `${entityConfig.cacheKeyPrefix}_${entityId}`;
}

function isExtractMode(mode?: RateLimiterMode): boolean {
  return (
    mode === RateLimiterMode.Extract ||
    mode === RateLimiterMode.ExtractStatus ||
    mode === RateLimiterMode.ExtractAgentPreview
  );
}

async function setCachedACUCGeneric<T>(
  entityConfig: ACUCEntityConfig,
  entityId: string,
  isExtract: boolean,
  acuc: T | null | ((acuc: T) => T | null),
): Promise<void> {
  const cacheKeyACUC = buildCacheKey(entityConfig, entityId, isExtract);
  const redLockKey = `lock_${cacheKeyACUC}`;

  try {
    await redlock.using([redLockKey], 10000, {}, async signal => {
      if (typeof acuc === "function") {
        acuc = (acuc as (acuc: T) => T | null)(
          JSON.parse((await getValue(cacheKeyACUC)) ?? "null"),
        );

        if (acuc === null) {
          if (signal.aborted) {
            throw signal.error;
          }
          return;
        }
      }

      if (signal.aborted) {
        throw signal.error;
      }

      // Cache for 10 minutes. - mogery
      await setValue(cacheKeyACUC, JSON.stringify(acuc), 600, true);
    });
  } catch (error) {
    logger.error(`Error updating cached ACUC ${cacheKeyACUC}: ${error}`);
  }
}

async function getACUCGeneric<T extends AuthCreditUsageChunk>(
  entityConfig: ACUCEntityConfig,
  entityId: string,
  cacheOnly: boolean,
  useCache: boolean,
  isExtract: boolean,
  mockChecker: () => T | null,
  setCacheFunc: (id: string, isExtract: boolean, chunk: T) => Promise<void>,
): Promise<T | null> {
  // Handle mock/bypass scenarios
  const mockResult = mockChecker();
  if (mockResult !== null) {
    return mockResult;
  }

  const cacheKeyACUC = buildCacheKey(entityConfig, entityId, isExtract);

  if (useCache) {
    const cachedACUC = await getValue(cacheKeyACUC);
    if (cachedACUC !== null) {
      return JSON.parse(cachedACUC);
    }
  }

  if (!cacheOnly) {
    let data;
    let error;
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      const client = !!config.SUPABASE_ACUC_URL
        ? supabase_acuc_only_service
        : Math.random() > 2 / 3
          ? supabase_rr_service
          : supabase_service;

      const rpcParams: Record<string, unknown> = {
        [entityConfig.rpcInputParamName]: entityId,
        i_is_extract: isExtract,
        tally_untallied_credits: true,
      };

      ({ data, error } = await client.rpc(
        entityConfig.rpcFunctionName,
        rpcParams,
        { get: true },
      ));

      if (!error) {
        break;
      }

      logger.warn(
        `Failed to retrieve authentication and credit usage data after ${retries}, trying again...`,
        { error },
      );
      retries++;
      if (retries === maxRetries) {
        throw new Error(
          "Failed to retrieve authentication and credit usage data after 3 attempts: " +
            JSON.stringify(error),
        );
      }

      // Wait for a short time before retrying
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const chunk: T | null =
      data.length === 0 ? null : data[0].team_id === null ? null : data[0];

    if (chunk) {
      chunk.is_extract = isExtract;
    }

    // NOTE: Should we cache null chunks? - mogery
    if (chunk !== null && useCache) {
      setCacheFunc(entityId, isExtract, chunk);
    }

    return chunk;
  } else {
    return null;
  }
}

async function clearACUCGeneric(
  entityConfig: ACUCEntityConfig,
  entityId: string,
): Promise<void> {
  // Delete cache for all rate limiter modes (extract and scrape)
  const modes = [true, false];
  await Promise.all(
    modes.map(async mode => {
      const cacheKey = buildCacheKey(entityConfig, entityId, mode);
      await deleteKey(cacheKey);
    }),
  );

  // Also clear the base cache key
  await deleteKey(buildBaseCacheKey(entityConfig, entityId));
}

// ============================================================================
// Mock Data Generators
// ============================================================================

const mockPreviewACUC: (
  team_id: string,
  is_extract: boolean,
) => AuthCreditUsageChunk = (team_id, is_extract) => ({
  api_key: "preview",
  api_key_id: 0,
  team_id,
  sub_id: null,
  sub_current_period_start: null,
  sub_current_period_end: null,
  sub_user_id: null,
  price_id: null,
  rate_limits: {
    crawl: 2,
    scrape: 10,
    extract: 10,
    search: 5,
    map: 5,
    preview: 5,
    crawlStatus: 500,
    extractStatus: 500,
    extractAgentPreview: 1,
    scrapeAgentPreview: 5,
  },
  price_credits: 99999999,
  price_should_be_graceful: false,
  price_associated_auto_recharge_price_id: null,
  credits_used: 0,
  coupon_credits: 99999999,
  adjusted_credits_used: 0,
  remaining_credits: 99999999,
  total_credits_sum: 99999999,
  plan_priority: {
    bucketLimit: 25,
    planModifier: 0.1,
  },
  concurrency: is_extract ? 200 : 2,
  flags: null,
  is_extract,
});

const mockACUC: () => AuthCreditUsageChunk = () => ({
  api_key: "bypass",
  api_key_id: 0,
  team_id: "bypass",
  sub_id: "bypass",
  sub_current_period_start: new Date().toISOString(),
  sub_current_period_end: new Date(
    new Date().getTime() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString(),
  sub_user_id: "bypass",
  price_id: "bypass",
  rate_limits: {
    crawl: 99999999,
    scrape: 99999999,
    extract: 99999999,
    search: 99999999,
    map: 99999999,
    preview: 99999999,
    crawlStatus: 99999999,
    extractStatus: 99999999,
    extractAgentPreview: 99999999,
    scrapeAgentPreview: 99999999,
  },
  price_credits: 99999999,
  price_should_be_graceful: false,
  price_associated_auto_recharge_price_id: null,
  credits_used: 0,
  coupon_credits: 99999999,
  adjusted_credits_used: 0,
  remaining_credits: 99999999,
  total_credits_sum: 99999999,
  plan_priority: {
    bucketLimit: 25,
    planModifier: 0.1,
  },
  concurrency: 99999999,
  flags: null,
  is_extract: false,
});

// ============================================================================
// Public API - API Key Based Operations
// ============================================================================

export async function setCachedACUC(
  api_key: string,
  is_extract: boolean,
  acuc:
    | AuthCreditUsageChunk
    | null
    | ((acuc: AuthCreditUsageChunk) => AuthCreditUsageChunk | null),
) {
  return setCachedACUCGeneric(API_KEY_CONFIG, api_key, is_extract, acuc);
}

export async function getACUC(
  api_key: string,
  cacheOnly = false,
  useCache = true,
  mode?: RateLimiterMode,
): Promise<AuthCreditUsageChunk | null> {
  const isExtract = isExtractMode(mode);

  return getACUCGeneric<AuthCreditUsageChunk>(
    API_KEY_CONFIG,
    api_key,
    cacheOnly,
    useCache,
    isExtract,
    () => {
      if (api_key === config.PREVIEW_TOKEN) {
        const acuc = mockPreviewACUC(api_key, isExtract);
        acuc.is_extract = isExtract;
        return acuc;
      }
      if (config.USE_DB_AUTHENTICATION !== true && !config.SUPABASE_ACUC_URL) {
        const acuc = mockACUC();
        acuc.is_extract = isExtract;
        return acuc;
      }
      return null;
    },
    setCachedACUC,
  );
}

export async function clearACUC(api_key: string): Promise<void> {
  return clearACUCGeneric(API_KEY_CONFIG, api_key);
}

// ============================================================================
// Public API - Team ID Based Operations
// ============================================================================

export async function setCachedACUCTeam(
  team_id: string,
  is_extract: boolean,
  acuc:
    | AuthCreditUsageChunkFromTeam
    | null
    | ((
        acuc: AuthCreditUsageChunkFromTeam,
      ) => AuthCreditUsageChunkFromTeam | null),
) {
  return setCachedACUCGeneric(TEAM_CONFIG, team_id, is_extract, acuc);
}

export async function getACUCTeam(
  team_id: string,
  cacheOnly = false,
  useCache = true,
  mode?: RateLimiterMode,
): Promise<AuthCreditUsageChunkFromTeam | null> {
  const isExtract = isExtractMode(mode);

  return getACUCGeneric<AuthCreditUsageChunk>(
    TEAM_CONFIG,
    team_id,
    cacheOnly,
    useCache,
    isExtract,
    () => {
      if (team_id.startsWith("preview")) {
        return mockPreviewACUC(team_id, isExtract);
      }
      if (config.USE_DB_AUTHENTICATION !== true && !config.SUPABASE_ACUC_URL) {
        const acuc = mockACUC();
        acuc.is_extract = isExtract;
        return acuc;
      }
      return null;
    },
    setCachedACUCTeam as (
      id: string,
      isExtract: boolean,
      chunk: AuthCreditUsageChunk,
    ) => Promise<void>,
  );
}

export async function clearACUCTeam(team_id: string): Promise<void> {
  await clearACUCGeneric(TEAM_CONFIG, team_id);

  // Add team to billed_teams set so tally gets updated too
  await getRedisConnection().sadd("billed_teams", team_id);
}

// ============================================================================
// Authentication
// ============================================================================

export async function authenticateUser(
  req,
  res,
  mode?: RateLimiterMode,
): Promise<AuthResponse> {
  if (!!config.SUPABASE_ACUC_URL) {
    return supaAuthenticateUser(req, res, mode);
  }

  return withAuth(supaAuthenticateUser, {
    success: true,
    chunk: null,
    team_id: "bypass",
  })(req, res, mode);
}

async function supaAuthenticateUser(
  req,
  res,
  mode?: RateLimiterMode,
): Promise<AuthResponse> {
  const authHeader =
    req.headers.authorization ??
    (req.headers["sec-websocket-protocol"]
      ? `Bearer ${req.headers["sec-websocket-protocol"]}`
      : null);
  if (!authHeader) {
    return { success: false, error: "Unauthorized", status: 401 };
  }
  const token = authHeader.split(" ")[1]; // Extract the token from "Bearer <token>"
  if (!token) {
    return {
      success: false,
      error: "Unauthorized: Token missing",
      status: 401,
    };
  }

  const incomingIP = (req.headers["x-preview-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress) as string;
  const iptoken = incomingIP + token;

  let rateLimiter: RateLimiterRedis;
  let subscriptionData: { team_id: string } | null = null;
  let normalizedApi: string;

  let teamId: string | null = null;
  let priceId: string | null = null;
  let chunk: AuthCreditUsageChunk | null = null;
  if (token == "this_is_just_a_preview_token") {
    throw new Error(
      "Unauthenticated Playground calls are temporarily disabled due to abuse. Please sign up.",
    );
  }
  if (token == config.PREVIEW_TOKEN) {
    if (mode == RateLimiterMode.CrawlStatus) {
      rateLimiter = getRateLimiter(RateLimiterMode.CrawlStatus, token);
    } else if (mode == RateLimiterMode.ExtractStatus) {
      rateLimiter = getRateLimiter(RateLimiterMode.ExtractStatus, token);
    } else {
      rateLimiter = getRateLimiter(RateLimiterMode.Preview, token);
    }
    teamId = `preview_${iptoken}`;
  } else {
    normalizedApi = parseApi(token);
    if (!normalizedApiIsUuid(normalizedApi)) {
      return {
        success: false,
        error: "Unauthorized: Invalid token",
        status: 401,
      };
    }

    chunk = await getACUC(normalizedApi, false, true, RateLimiterMode.Scrape);

    if (chunk === null) {
      return {
        success: false,
        error: "Unauthorized: Invalid token",
        status: 401,
      };
    }

    teamId = chunk.team_id;
    priceId = chunk.price_id;

    subscriptionData = {
      team_id: teamId,
    };
    rateLimiter = getRateLimiter(
      mode ?? RateLimiterMode.Crawl,
      chunk.rate_limits,
    );
  }

  const team_endpoint_token = token === config.PREVIEW_TOKEN ? iptoken : teamId;

  try {
    await rateLimiter.consume(team_endpoint_token);
  } catch (rateLimiterRes) {
    logger.error(`Rate limit exceeded: ${rateLimiterRes}`, {
      teamId,
      priceId,
      mode,
      rateLimits: chunk?.rate_limits,
      rateLimiterRes,
    });
    const secs = Math.round(rateLimiterRes.msBeforeNext / 1000) || 1;
    const retryDate = new Date(Date.now() + rateLimiterRes.msBeforeNext);

    // We can only send a rate limit email every 7 days, send notification already has the date in between checking
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 7);

    // await sendNotification(team_id, NotificationType.RATE_LIMIT_REACHED, startDate.toISOString(), endDate.toISOString());

    return {
      success: false,
      error: `Rate limit exceeded. Consumed (req/min): ${rateLimiterRes.consumedPoints}, Remaining (req/min): ${rateLimiterRes.remainingPoints}. Upgrade your plan at https://firecrawl.dev/pricing for increased rate limits or please retry after ${secs}s, resets at ${retryDate}`,
      status: 429,
    };
  }

  if (
    token === config.PREVIEW_TOKEN &&
    (mode === RateLimiterMode.Scrape ||
      mode === RateLimiterMode.Preview ||
      mode === RateLimiterMode.Map ||
      mode === RateLimiterMode.Crawl ||
      mode === RateLimiterMode.CrawlStatus ||
      mode === RateLimiterMode.Extract ||
      mode === RateLimiterMode.Search)
  ) {
    return {
      success: true,
      team_id: `preview_${iptoken}`,
      chunk: null,
    };
    // check the origin of the request and make sure its from firecrawl.dev
    // const origin = req.headers.origin;
    // if (origin && origin.includes("firecrawl.dev")){
    //   return { success: true, team_id: "preview" };
    // }
    // if(config.ENV !== "production") {
    //   return { success: true, team_id: "preview" };
    // }

    // return { success: false, error: "Unauthorized: Invalid token", status: 401 };
  }

  return {
    success: true,
    team_id: teamId ?? undefined,
    chunk,
  };
}
