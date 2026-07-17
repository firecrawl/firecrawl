import * as crypto from "crypto";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { isValidUuid } from "../lib/owner-id";
import { config } from "../config";
import { logger } from "../lib/logger";
import { parseApi } from "../lib/parseApi";
import { withAuth } from "../lib/withAuth";
import { getAgentSponsorStatus } from "../services/agent-sponsor";
import { getRateLimiter } from "../services/rate-limiter";
import {
  KEYLESS_FREE_TIER_LIMIT_MESSAGE,
  consumeKeylessRequest,
  isKeylessConfigured,
  isKeylessIpEligible,
  keylessTeamId,
} from "../lib/keyless";
import { isKeylessIpSuspicious } from "../lib/spur";
import { checkIpRestriction } from "../lib/ip-restriction";
import { checkKeyEndpointRestriction } from "../lib/key-restriction";
import { deleteKey, getValue, setValue } from "../services/redis";
import { redlock } from "../services/redlock";
import { eq } from "drizzle-orm";
import { db, dbRr } from "../db/connection";
import * as schema from "../db/schema";
import {
  authCreditUsageChunk,
  authCreditUsageChunkFromTeam,
  AuthCreditUsageChunkRow,
} from "../db/rpc";
import { AuthResponse, RateLimiterMode } from "../types";
import { AuthCreditUsageChunk, AuthCreditUsageChunkFromTeam } from "./v1/types";

function normalizedApiIsUuid(potentialUuid: string): boolean {
  // Check if the string is a valid UUID
  return isValidUuid(potentialUuid);
}

async function setCachedACUC(
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
  plan_priority: {
    bucketLimit: 25,
    planModifier: 0.1,
  },
  concurrency: 99999999,
  flags: null,
  is_extract: false,
});

/**
 * Introspection response from the OAuth token endpoint.
 */
interface OAuthIntrospectionResponse {
  active: boolean;
  api_key: string;
  scope: string;
  client_id: string;
  team_id: string;
  exp: number;
}

/**
 * Resolve an OAuth access token (fco_…) to the underlying API key via
 * the introspection endpoint. Results are cached in Redis for the
 * remaining token TTL (up to 5 minutes).
 */
async function resolveOAuthToken(
  token: string,
): Promise<OAuthIntrospectionResponse | null> {
  const introspectUrl = config.OAUTH_INTROSPECT_URL;
  const introspectSecret = config.OAUTH_INTROSPECT_SECRET;

  if (!introspectUrl || !introspectSecret) {
    logger.warn(
      "OAuth introspection not configured (OAUTH_INTROSPECT_URL / OAUTH_INTROSPECT_SECRET)",
    );
    return null;
  }

  // Check Redis cache first (hash the token to avoid leaking material in key names)
  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex")
    .substring(0, 32);
  const cacheKey = `oauth_token:${tokenHash}`;
  const cached = await getValue(cacheKey);
  if (cached !== null) {
    try {
      const parsed = JSON.parse(cached);
      if (!parsed.active) return null;
      return parsed;
    } catch {
      // Corrupt cache entry — treat as a miss
    }
  }

  try {
    const response = await fetch(introspectUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${introspectSecret}`,
      },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      logger.error("OAuth introspection request failed", {
        status: response.status,
      });
      return null;
    }

    const data = (await response.json()) as OAuthIntrospectionResponse;

    // Cache the result — use remaining TTL (max 5 minutes) or 60s for inactive
    if (data.active) {
      const remainingSeconds = Math.max(
        0,
        data.exp - Math.floor(Date.now() / 1000),
      );
      const cacheTtl = Math.min(remainingSeconds, 300); // Cap at 5 minutes
      if (cacheTtl > 0) {
        await setValue(cacheKey, JSON.stringify(data), cacheTtl);
      }
    } else {
      // Cache negative results briefly to avoid hammering introspection
      await setValue(cacheKey, JSON.stringify({ active: false }), 60);
    }

    return data.active ? data : null;
  } catch (error) {
    logger.error("OAuth introspection error", { error });
    return null;
  }
}

async function getACUC(
  api_key: string,
  cacheOnly = false,
  useCache = true,
  mode?: RateLimiterMode,
): Promise<AuthCreditUsageChunk | null> {
  let isExtract =
    mode === RateLimiterMode.Extract ||
    mode === RateLimiterMode.ExtractStatus ||
    mode === RateLimiterMode.ExtractAgentPreview;

  if (api_key === config.PREVIEW_TOKEN) {
    const acuc = mockPreviewACUC(api_key, isExtract);
    acuc.is_extract = isExtract;
    return acuc;
  }

  if (config.USE_DB_AUTHENTICATION !== true) {
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
    let data: AuthCreditUsageChunkRow[] = [];
    let retries = 0;
    const maxRetries = 5;
    while (retries < maxRetries) {
      const database = Math.random() > 2 / 3 ? dbRr : db;
      try {
        data = await authCreditUsageChunk(database, api_key);
        break;
      } catch (error) {
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
    }

    const chunk: AuthCreditUsageChunk | null =
      data.length === 0
        ? null
        : data[0].team_id === null
          ? null
          : (data[0] as any);

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

async function setCachedACUCTeam(
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

  if (config.USE_DB_AUTHENTICATION !== true) {
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
    let data: AuthCreditUsageChunkRow[] = [];
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      const database = Math.random() > 2 / 3 ? dbRr : db;
      try {
        data = await authCreditUsageChunkFromTeam(database, team_id);
        break;
      } catch (error) {
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
    }

    const chunk: AuthCreditUsageChunk | null =
      data.length === 0
        ? null
        : data[0].team_id === null
          ? null
          : (data[0] as any);

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

const KEYLESS_ENDPOINT_NOT_AVAILABLE_MESSAGE = `This endpoint is not supported by the keyless free tier. Sign up for a free API key at https://www.firecrawl.dev/signin for more endpoints, more usage, and higher rate limits.

Then authenticate with:
Authorization: Bearer YOUR_API_KEY`;

const KEYLESS_SUSPICIOUS_IP_MESSAGE = `Unfortunately, your IP address looks suspicious, so Firecrawl can't be used without an API key from here. Sign up for a free API key at https://firecrawl.dev for 1000 credits and higher rate limits for free. (If you're an agent, you can also use https://firecrawl.dev/auth.md)`;

/**
 * Keyless free tier: official MCP/CLI/SDK clients can call scrape, search, and
 * interact with no API key. `origin`/`integration` are client-set and spoofable,
 * so they're only a soft UX gate — the real abuse controls are the per-IP daily
 * request + credit caps plus the `keyless/consume` canonical log emitted here.
 * Always returns an AuthResponse — handles every no-API-key request.
 */
async function handleKeylessAuth(
  req,
  mode: RateLimiterMode | undefined,
  allowKeyless: boolean | undefined,
): Promise<AuthResponse> {
  const unauthorized: AuthResponse = {
    success: false,
    error: "Unauthorized",
    status: 401,
  };

  // The keyless tier is off unless BOTH limits are configured (even to 0). When
  // unconfigured we behave exactly as before — a generic 401 — and don't reveal
  // that the tier exists.
  if (!isKeylessConfigured()) return unauthorized;

  // Configured, but this endpoint isn't part of the keyless tier: tell the user
  // they need a key (with the signup nudge) rather than a bare "Unauthorized".
  if (!allowKeyless) {
    return {
      success: false,
      error: KEYLESS_ENDPOINT_NOT_AVAILABLE_MESSAGE,
      status: 401,
    };
  }

  const origin = req.body?.origin;
  const integration = req.body?.integration;
  // No origin/surface gate: any request without an API key may use the free
  // tier on the allowlisted endpoints (the API itself is free). origin and
  // integration are still recorded below for abuse monitoring.

  // Key on the real client IP. A trusted proxy (e.g. the hosted MCP) may
  // forward the end-user's IP via x-firecrawl-keyless-ip, authenticated with a
  // shared secret — without the secret the header is ignored, so direct callers
  // can't spoof their IP to dodge the per-IP cap.
  let ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  if (
    config.KEYLESS_PROXY_SECRET &&
    req.headers["x-firecrawl-keyless-secret"] === config.KEYLESS_PROXY_SECRET
  ) {
    const forwarded = req.headers["x-firecrawl-keyless-ip"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      ip = forwarded.trim();
    }
  }

  // Only a valid IPv4 identity gets keyless: IPv6 is too cheap to rotate for a
  // per-IP cap to mean anything, and malformed/forwarded values must not be
  // usable as arbitrary limiter buckets. Anything else falls through to 401.
  if (!isKeylessIpEligible(ip)) return unauthorized;

  // Optional Spur Context check (only when SPUR_API_KEY is set): refuse keyless
  // for IPs fronting anonymizing/rotating infrastructure (VPN/proxy/TOR), the
  // main way the per-IP caps get bypassed. Fails open on any Spur error, and
  // runs before consuming quota so a flagged IP doesn't burn a request slot.
  if (await isKeylessIpSuspicious(ip)) {
    logger.warn("Keyless request blocked: suspicious IP", {
      canonicalLog: "keyless/consume",
      ip,
      origin: req.body?.origin,
      integration: req.body?.integration,
      blocked: true,
      reason: "suspicious",
    });
    return {
      success: false,
      error: KEYLESS_SUSPICIOUS_IP_MESSAGE,
      status: 403,
      // Tell agents where to find the key/signup flow they now need.
      agentAuthDiscovery: true,
    };
  }

  const teamId = keylessTeamId(ip);
  const modeLabel =
    mode === RateLimiterMode.Search
      ? "search"
      : mode === RateLimiterMode.Research
        ? "research"
        : mode === RateLimiterMode.BrowserExecute
          ? "interact"
          : "scrape";

  let result: Awaited<ReturnType<typeof consumeKeylessRequest>>;
  try {
    result = await consumeKeylessRequest(ip);
  } catch (error) {
    // Limiter store (Redis) unavailable — fail closed with a controlled auth
    // response instead of surfacing a 500, and shed the free traffic while the
    // limiter can't enforce quotas.
    logger.warn("Keyless quota check failed", {
      canonicalLog: "keyless/consume",
      ip,
      mode: modeLabel,
      teamId,
      error,
    });
    return unauthorized;
  }
  const baseLog = {
    canonicalLog: "keyless/consume",
    ip,
    origin,
    integration,
    mode: modeLabel,
    teamId,
    requestsUsed: result.requestsUsed,
    creditsUsed: result.creditsUsed,
  };

  if (!result.ok) {
    logger.warn("Keyless request blocked", {
      ...baseLog,
      blocked: true,
      reason: result.reason,
    });
    return {
      success: false,
      error: KEYLESS_FREE_TIER_LIMIT_MESSAGE,
      status: 429,
      // Out of free quota — emit the OAuth-discovery header so agents can find
      // the key/signup flow at the moment they actually need a key.
      agentAuthDiscovery: true,
    };
  }

  logger.debug("Keyless request consumed", { ...baseLog, blocked: false });

  // Tag as a preview team so billing (autumn isPreviewTeam) and GCS persistence
  // are skipped automatically; mockPreviewACUC supplies concurrency 2 + credits.
  // Actual credits consumed are charged to the IP's daily budget after the
  // request completes (see chargeKeylessCredits).
  return {
    success: true,
    team_id: teamId,
    org_id: null,
    chunk: mockPreviewACUC(teamId, false),
  };
}

export async function authenticateUser(
  req,
  res,
  mode?: RateLimiterMode,
  options?: { allowKeyless?: boolean },
): Promise<AuthResponse> {
  const bypassChunk = mockACUC();
  bypassChunk.is_extract =
    mode === RateLimiterMode.Extract ||
    mode === RateLimiterMode.ExtractStatus ||
    mode === RateLimiterMode.ExtractAgentPreview;

  return withAuth(supaAuthenticateUser, {
    success: true,
    chunk: bypassChunk,
    team_id: bypassChunk.team_id,
    org_id: null,
  })(req, res, mode, options);
}

/**
 * Backfills org_id for stale cached auth chunks so Autumn check gating can run.
 */
async function ensureChunkOrgId(
  apiKey: string,
  chunk: AuthCreditUsageChunk | null,
): Promise<AuthCreditUsageChunk | null> {
  if (!chunk || chunk.org_id || config.USE_DB_AUTHENTICATION !== true) {
    return chunk;
  }

  let data: { org_id: string | null } | undefined;
  try {
    [data] = await dbRr
      .select({ org_id: schema.teams.org_id })
      .from(schema.teams)
      .where(eq(schema.teams.id, chunk.team_id))
      .limit(1);
  } catch (error) {
    logger.warn("Failed to backfill org_id for auth chunk", {
      teamId: chunk.team_id,
      error,
    });
    return chunk;
  }

  if (!data?.org_id) {
    logger.warn("Failed to backfill org_id for auth chunk", {
      teamId: chunk.team_id,
    });
    return chunk;
  }

  chunk.org_id = data.org_id;
  await setCachedACUC(apiKey, !!chunk.is_extract, chunk);
  return chunk;
}

async function supaAuthenticateUser(
  req,
  res,
  mode?: RateLimiterMode,
  options?: { allowKeyless?: boolean },
): Promise<AuthResponse> {
  const authHeader =
    req.headers.authorization ??
    (req.headers["sec-websocket-protocol"]
      ? `Bearer ${req.headers["sec-websocket-protocol"]}`
      : null);
  if (!authHeader) {
    return handleKeylessAuth(req, mode, options?.allowKeyless);
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
  } else if (token.startsWith("fco_")) {
    // OAuth access token — resolve via introspection endpoint
    const introspection = await resolveOAuthToken(token);
    if (!introspection) {
      return {
        success: false,
        error: "Unauthorized: Invalid or expired OAuth token",
        status: 401,
      };
    }

    // Use the resolved fc- API key to get the normal ACUC chunk
    const resolvedApi = parseApi(introspection.api_key);
    chunk = await getACUC(resolvedApi, false, true, RateLimiterMode.Scrape);
    chunk = await ensureChunkOrgId(resolvedApi, chunk);

    if (chunk === null) {
      return {
        success: false,
        error: "Unauthorized: Invalid token",
        status: 401,
      };
    }

    teamId = chunk.team_id;

    subscriptionData = {
      team_id: teamId,
    };
    rateLimiter = getRateLimiter(
      mode ?? RateLimiterMode.Crawl,
      chunk.rate_limits,
    );
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
    chunk = await ensureChunkOrgId(normalizedApi, chunk);

    if (chunk === null) {
      return {
        success: false,
        error: "Unauthorized: Invalid token",
        status: 401,
      };
    }

    teamId = chunk.team_id;

    subscriptionData = {
      team_id: teamId,
    };
    rateLimiter = getRateLimiter(
      mode ?? RateLimiterMode.Crawl,
      chunk.rate_limits,
    );
  }

  if (chunk?.flags?.ipRestriction) {
    const ipCheck = await checkIpRestriction(
      req.ip ?? req.socket?.remoteAddress,
      chunk.team_id,
      chunk.flags,
    );
    if (!ipCheck.allowed) {
      return {
        success: false,
        error: ipCheck.error,
        status: ipCheck.status,
      };
    }
  }

  if (chunk?.flags?.keyRestriction) {
    // Enforced here rather than in route middleware so every authenticated
    // surface (v0/v1/v2, websocket status) goes through the same gate.
    const endpointCheck = await checkKeyEndpointRestriction(
      req.originalUrl ?? req.url ?? "",
      chunk.api_key_id,
      chunk.flags,
    );
    if (!endpointCheck.allowed) {
      return {
        success: false,
        error: endpointCheck.error,
        status: endpointCheck.status,
      };
    }
  }

  const team_endpoint_token = token === config.PREVIEW_TOKEN ? iptoken : teamId;

  try {
    await rateLimiter.consume(team_endpoint_token);
  } catch (rateLimiterRes) {
    // logger.error(`Rate limit exceeded: ${rateLimiterRes}`, {
    //   teamId,
    //   mode,
    //   rateLimits: chunk?.rate_limits,
    //   rateLimiterRes,
    // });

    const secs = Math.round(rateLimiterRes.msBeforeNext / 1000) || 1;
    const retryDate = new Date(Date.now() + rateLimiterRes.msBeforeNext);

    // We can only send a rate limit email every 7 days, send notification already has the date in between checking
    // const startDate = new Date();
    // const endDate = new Date();
    // endDate.setDate(endDate.getDate() + 7);

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
      mode === RateLimiterMode.Search ||
      mode === RateLimiterMode.Research)
  ) {
    return {
      success: true,
      team_id: `preview_${iptoken}`,
      org_id: null,
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

  // Check if this is an agent-provisioned key and attach sponsor status
  if (chunk && chunk.api_key_id) {
    try {
      const sponsorStatus = await getAgentSponsorStatus({
        apiKeyId: chunk.api_key_id,
      });
      if (sponsorStatus) {
        chunk._agentSponsor = {
          status: sponsorStatus.status,
          verification_deadline: sponsorStatus.verification_deadline,
          email: sponsorStatus.email,
        };
      }
    } catch (err) {
      logger.warn("Failed to check agent sponsor status", {
        error: err,
        api_key_id: chunk.api_key_id,
      });
    }
  }

  return {
    success: true,
    team_id: teamId ?? undefined,
    org_id: chunk?.org_id ?? null,
    chunk,
  };
}
