import { parseApi } from "../lib/parseApi";
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
import { validate } from "uuid";
import * as Sentry from "@sentry/node";
import { AuthCreditUsageChunk, AuthCreditUsageChunkFromTeam } from "./v1/types";

function normalizedApiIsUuid(potentialUuid: string): boolean {
  // Check if the string is a valid UUID
  return validate(potentialUuid);
}

export async function setCachedACUC(
  api_key: string,
  is_extract: boolean,
  acuc:
    | AuthCreditUsageChunk
    | null
    | ((acuc: AuthCreditUsageChunk) => AuthCreditUsageChunk | null),
) {
  const cacheKeyACUC = `acuc_${api_key}_${is_extract ? "extract" : "scrape"}`;
  const redLockKey = `lock_${cacheKeyACUC}`;

  try {
    await redlock.using([redLockKey], 10000, {}, async signal => {
      if (typeof acuc === "function") {
        acuc = acuc(JSON.parse((await getValue(cacheKeyACUC)) ?? "null"));

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

export async function getACUC(
  api_key: string,
  cacheOnly = false,
  useCache = true,
  mode?: RateLimiterMode,
): Promise<AuthCreditUsageChunk | null> {
  let isExtract =
    mode === RateLimiterMode.Extract ||
    mode === RateLimiterMode.ExtractStatus ||
    mode === RateLimiterMode.ExtractAgentPreview;

  if (api_key === process.env.PREVIEW_TOKEN) {
    const acuc = mockPreviewACUC(api_key, isExtract);
    acuc.is_extract = isExtract;
    return acuc;
  }

  if (
    process.env.USE_DB_AUTHENTICATION !== "true" &&
    !process.env.SUPABASE_ACUC_URL
  ) {
    const acuc = mockACUC();
    acuc.is_extract = isExtract;
    return acuc;
  }

  const cacheKeyACUC = `acuc_${api_key}_${isExtract ? "extract" : "scrape"}`;

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
      const client = !!process.env.SUPABASE_ACUC_URL
        ? supabase_acuc_only_service
        : Math.random() > 2 / 3
          ? supabase_rr_service
          : supabase_service;
      ({ data, error } = await client.rpc(
        "auth_credit_usage_chunk_36",
        {
          input_key: api_key,
          i_is_extract: isExtract,
          tally_untallied_credits: true,
        },
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

    const chunk: AuthCreditUsageChunk | null =
      data.length === 0 ? null : data[0].team_id === null ? null : data[0];

    if (chunk) {
      chunk.is_extract = isExtract;
    }

    // NOTE: Should we cache null chunks? - mogery
    if (chunk !== null && useCache) {
      setCachedACUC(api_key, isExtract, chunk);
    }

    return chunk;
  } else {
    return null;
  }
}

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
  const cacheKeyACUC = `acuc_team_${team_id}_${is_extract ? "extract" : "scrape"}`;
  const redLockKey = `lock_${cacheKeyACUC}`;

  try {
    await redlock.using([redLockKey], 10000, {}, async signal => {
      if (typeof acuc === "function") {
        acuc = acuc(JSON.parse((await getValue(cacheKeyACUC)) ?? "null"));

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

export async function getACUCTeam(
  team_id: string,
  cacheOnly = false,
  useCache = true,
  mode?: RateLimiterMode,
): Promise<AuthCreditUsageChunkFromTeam | null> {
  let isExtract =
    mode === RateLimiterMode.Extract ||
    mode === RateLimiterMode.ExtractStatus ||
    mode === RateLimiterMode.ExtractAgentPreview;

  if (team_id.startsWith("preview")) {
    const acuc = mockPreviewACUC(team_id, isExtract);
    return acuc;
  }

  if (
    process.env.USE_DB_AUTHENTICATION !== "true" &&
    !process.env.SUPABASE_ACUC_URL
  ) {
    const acuc = mockACUC();
    acuc.is_extract = isExtract;
    return acuc;
  }

  const cacheKeyACUC = `acuc_team_${team_id}_${isExtract ? "extract" : "scrape"}`;

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
      const client = !!process.env.SUPABASE_ACUC_URL
        ? supabase_acuc_only_service
        : Math.random() > 2 / 3
          ? supabase_rr_service
          : supabase_service;
      ({ data, error } = await client.rpc(
        "auth_credit_usage_chunk_36_from_team",
        {
          input_team: team_id,
          i_is_extract: isExtract,
          tally_untallied_credits: true,
        },
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

    const chunk: AuthCreditUsageChunk | null =
      data.length === 0 ? null : data[0].team_id === null ? null : data[0];

    // NOTE: Should we cache null chunks? - mogery
    if (chunk !== null && useCache) {
      setCachedACUCTeam(team_id, isExtract, chunk);
    }

    return chunk ? { ...chunk, is_extract: isExtract } : null;
  } else {
    return null;
  }
}

export async function clearACUC(api_key: string): Promise<void> {
  // Delete cache for all rate limiter modes
  const modes = [true, false];
  await Promise.all(
    modes.map(async mode => {
      const cacheKey = `acuc_${api_key}_${mode ? "extract" : "scrape"}`;
      await deleteKey(cacheKey);
    }),
  );

  // Also clear the base cache key
  await deleteKey(`acuc_${api_key}`);
}

export async function clearACUCTeam(team_id: string): Promise<void> {
  // Delete cache for all rate limiter modes
  const modes = [true, false];
  await Promise.all(
    modes.map(async mode => {
      const cacheKey = `acuc_team_${team_id}_${mode ? "extract" : "scrape"}`;
      await deleteKey(cacheKey);
    }),
  );

  // Also clear the base cache key
  await deleteKey(`acuc_team_${team_id}`);
}

export async function authenticateUser(
  req,
  res,
  mode?: RateLimiterMode,
): Promise<AuthResponse> {
  if (!!process.env.SUPABASE_ACUC_URL) {
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
  if (token == process.env.PREVIEW_TOKEN) {
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

    chunk = await getACUC(normalizedApi, false, true, mode);

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

  const team_endpoint_token =
    token === process.env.PREVIEW_TOKEN ? iptoken : teamId;

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
    token === process.env.PREVIEW_TOKEN &&
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
    // if(process.env.ENV !== "production") {
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
