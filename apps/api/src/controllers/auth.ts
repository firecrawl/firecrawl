import { ReplyError } from "ioredis";
import { config } from "../config";
import { db, dbRr } from "../db/connection";
import {
  authCreditUsageChunk,
  authCreditUsageChunkFromTeam,
  AuthCreditUsageChunkRow,
} from "../db/rpc";
import { logger } from "../lib/logger";
import { isValidUuid } from "../lib/owner-id";
import { parseApi } from "../lib/parseApi";
import { timingSafeSecretEqual } from "../lib/secret-compare";
import {
  autumnService,
  DEFAULT_TEAM_LIMITS,
  type TeamLimits,
} from "../services/autumn/autumn.service";
import { deleteKey, getValue, setValue } from "../services/redis";
import { redlock } from "../services/redlock";
import { RateLimiterMode } from "../types";
import {
  AuthCreditUsageChunk,
  AuthCreditUsageChunkFromTeam,
  TeamFlags,
} from "./v2/types";

const ACUC_TTL_SECONDS = 600;
// A chunk built on the fail-open limits is cached only briefly, so a
// transient Autumn error is retried within a minute.
const ACUC_FAIL_OPEN_TTL_SECONDS = 60;
// When Autumn can't answer, fail open rather than throttle or gate real teams
// on the low defaults. Generous but bounded: the concurrency queue cap still
// applies. The plan class is the exception and fails closed: these limits
// carry none, so nothing is stated about a team whose plan could not be read.
const FAIL_OPEN_LIMITS: TeamLimits = {
  concurrency_limit: 200,
  rate_limit_multiplier: 2500,
  is_paid_plan: true,
};

/** The team's effective limits, and how long a chunk carrying them may live. */
async function readTeamLimits(
  teamId: string,
  orgId: string | null,
): Promise<{ limits: TeamLimits; ttl: number }> {
  try {
    return {
      limits: await autumnService.getTeamLimits(teamId, orgId),
      ttl: ACUC_TTL_SECONDS,
    };
  } catch (error) {
    logger.error("Autumn limits unavailable, failing open", { teamId, error });
    return { limits: FAIL_OPEN_LIMITS, ttl: ACUC_FAIL_OPEN_TTL_SECONDS };
  }
}

/** A cached chunk, with live limits when it predates them (not written back). */
async function withLimits<T extends AuthCreditUsageChunkFromTeam>(
  chunk: T,
): Promise<T> {
  if (
    chunk.concurrency_limit !== undefined &&
    chunk.rate_limit_multiplier !== undefined &&
    chunk.is_paid_plan !== undefined
  ) {
    return chunk;
  }
  return {
    ...chunk,
    ...(await readTeamLimits(chunk.team_id, chunk.org_id)).limits,
  };
}

function normalizedApiIsUuid(potentialUuid: string): boolean {
  return isValidUuid(potentialUuid);
}

async function setCachedACUC(
  api_key: string,
  is_extract: boolean,
  acuc:
    | AuthCreditUsageChunk
    | null
    | ((acuc: AuthCreditUsageChunk) => AuthCreditUsageChunk | null),
  credentialPurpose: "general" | "hosted_mcp_oauth" = "general",
  ttl = ACUC_TTL_SECONDS,
) {
  const cacheKeyACUC = `acuc_${credentialPurpose}_${api_key}_${is_extract ? "extract" : "scrape"}`;
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

      await setValue(cacheKeyACUC, JSON.stringify(acuc), ttl, true);
    });
  } catch (error) {
    logger.error("Error updating cached ACUC", {
      error,
    });
  }
}

export const mockPreviewACUC: (
  team_id: string,
  is_extract: boolean,
) => AuthCreditUsageChunk = (team_id, is_extract) => ({
  api_key: "preview",
  api_key_id: 0,
  team_id,
  org_id: "preview",
  flags: null,
  is_banned: false,
  is_extract,
  ...DEFAULT_TEAM_LIMITS,
});

const mockACUC: () => AuthCreditUsageChunk = () => ({
  api_key: "bypass",
  api_key_id: 0,
  team_id: "bypass",
  org_id: "bypass",
  flags: null,
  is_banned: false,
  is_extract: false,
  ...DEFAULT_TEAM_LIMITS,
});

export async function getACUC(
  api_key: string,
  cacheOnly = false,
  useCache = true,
  mode?: RateLimiterMode,
  credentialPurpose: "general" | "hosted_mcp_oauth" = "general",
  bypassWhenDbDisabled = true,
): Promise<AuthCreditUsageChunk | null> {
  // Managed OAuth credentials are connection-scoped and can be created or
  // revoked immediately before this request. Never serve them from Redis or a
  // lagging read replica: both authorization and revocation must observe the
  // primary database.
  const requiresPrimaryRead = credentialPurpose === "hosted_mcp_oauth";
  if (requiresPrimaryRead) useCache = false;

  const isExtract =
    mode === RateLimiterMode.Extract || mode === RateLimiterMode.ExtractStatus;

  if (timingSafeSecretEqual(api_key, config.PREVIEW_TOKEN)) {
    const acuc = mockPreviewACUC(api_key, isExtract);
    acuc.is_extract = isExtract;
    return acuc;
  }

  if (bypassWhenDbDisabled && config.USE_DB_AUTHENTICATION !== true) {
    const acuc = mockACUC();
    acuc.is_extract = isExtract;
    return acuc;
  }

  const cacheKeyACUC = `acuc_${credentialPurpose}_${api_key}_${isExtract ? "extract" : "scrape"}`;

  if (useCache) {
    let cachedACUC: string | null;
    try {
      cachedACUC = await getValue(cacheKeyACUC);
    } catch (error) {
      if (
        error instanceof ReplyError ||
        (error instanceof Error &&
          (error as any).address &&
          (error as any).code &&
          error.name === "Error") ||
        (error instanceof Error && error.name === "MaxRetriesPerRequestError")
      ) {
        logger.warn(
          "Reading ACUC out of cache redis failed, treating as miss",
          {
            error,
          },
        );
        cachedACUC = null;
      } else {
        throw error;
      }
    }
    if (cachedACUC !== null) {
      try {
        return await withLimits(JSON.parse(cachedACUC));
      } catch (error) {
        logger.warn("Ignoring malformed ACUC cache entry", {
          error,
        });
        void deleteKey(cacheKeyACUC).catch(deleteError => {
          logger.warn("Failed to delete malformed ACUC cache entry", {
            error: deleteError,
          });
        });
      }
    }
  }

  if (!cacheOnly) {
    let data: AuthCreditUsageChunkRow[] = [];
    let retries = 0;
    const maxRetries = 5;
    while (retries < maxRetries) {
      // General-purpose reads prefer the replica: the result is Redis-cached
      // for 10 minutes, so sub-second replication lag is irrelevant. Fall back
      // to the primary on replica error. hosted_mcp_oauth must stay on the
      // primary so revocation observes fresh state.
      const database = requiresPrimaryRead ? db : retries === 0 ? dbRr : db;
      try {
        data = await authCreditUsageChunk(database, api_key, credentialPurpose);
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

    if (chunk === null) return null;

    if (useCache) {
      const { limits, ttl } = await readTeamLimits(chunk.team_id, chunk.org_id);
      const built = { ...chunk, is_extract: isExtract, ...limits };
      setCachedACUC(api_key, isExtract, built, credentialPurpose, ttl);
      return built;
    }

    // An uncached chunk (a hosted MCP credential) takes the team ACUC's
    // limits, so authenticating it per request never costs an Autumn read.
    const team = await getACUCTeam(
      chunk.team_id,
      false,
      true,
      undefined,
      bypassWhenDbDisabled,
    ).catch(() => null);
    const limits =
      team ?? (await readTeamLimits(chunk.team_id, chunk.org_id)).limits;
    return {
      ...chunk,
      is_extract: isExtract,
      concurrency_limit: limits.concurrency_limit,
      rate_limit_multiplier: limits.rate_limit_multiplier,
      is_paid_plan: limits.is_paid_plan,
      plan_class: limits.plan_class,
    };
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
  ttl = ACUC_TTL_SECONDS,
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

      await setValue(cacheKeyACUC, JSON.stringify(acuc), ttl, true);
    });
  } catch (error) {
    logger.error("Error updating cached ACUC", {
      cacheKey: cacheKeyACUC,
      error,
    });
  }
}

export async function getACUCTeam(
  team_id: string,
  cacheOnly = false,
  useCache = true,
  mode?: RateLimiterMode,
  bypassWhenDbDisabled = true,
): Promise<AuthCreditUsageChunkFromTeam | null> {
  const isExtract =
    mode === RateLimiterMode.Extract || mode === RateLimiterMode.ExtractStatus;

  if (team_id.startsWith("preview")) {
    const acuc = mockPreviewACUC(team_id, isExtract);
    return acuc;
  }

  if (bypassWhenDbDisabled && config.USE_DB_AUTHENTICATION !== true) {
    const acuc = mockACUC();
    acuc.is_extract = isExtract;
    return acuc;
  }

  const cacheKeyACUC = `acuc_team_${team_id}_${isExtract ? "extract" : "scrape"}`;

  if (useCache) {
    let cachedACUC: string | null;
    try {
      cachedACUC = await getValue(cacheKeyACUC);
    } catch (error) {
      if (
        error instanceof ReplyError ||
        (error instanceof Error &&
          (error as any).address &&
          (error as any).code &&
          error.name === "Error") ||
        (error instanceof Error && error.name === "MaxRetriesPerRequestError")
      ) {
        logger.warn(
          "Reading ACUC out of cache redis failed, treating as miss",
          {
            cacheKey: cacheKeyACUC,
            error,
          },
        );
        cachedACUC = null;
      } else {
        throw error;
      }
    }
    if (cachedACUC !== null) {
      // A corrupt entry is a miss, not a failure: callers that fall back to a
      // null org on a throw would otherwise take the high fail-open limits.
      try {
        return await withLimits(JSON.parse(cachedACUC));
      } catch (error) {
        logger.warn("Ignoring malformed ACUC cache entry", {
          cacheKey: cacheKeyACUC,
          error,
        });
        void deleteKey(cacheKeyACUC).catch(deleteError => {
          logger.warn("Failed to delete malformed ACUC cache entry", {
            cacheKey: cacheKeyACUC,
            error: deleteError,
          });
        });
      }
    }
  }

  if (!cacheOnly) {
    let data: AuthCreditUsageChunkRow[] = [];
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      // Prefer the replica (10-minute Redis cache makes lag irrelevant); fall
      // back to the primary on replica error.
      const database = retries === 0 ? dbRr : db;
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

    if (chunk === null) return null;

    const { limits, ttl } = await readTeamLimits(chunk.team_id, chunk.org_id);
    const built = { ...chunk, ...limits };

    if (useCache) {
      setCachedACUCTeam(team_id, isExtract, built, ttl);
    }

    return { ...built, is_extract: isExtract };
  } else {
    return null;
  }
}

/**
 * The flags of the team behind a request's plain API key, read without rate
 * limiting or the other auth checks. Null without a known API key.
 */
export async function getApiKeyTeamFlags(req: {
  headers: { authorization?: string };
}): Promise<TeamFlags | null> {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return null;
  const normalizedApi = parseApi(token);
  if (!normalizedApiIsUuid(normalizedApi)) return null;
  const chunk = await getACUC(normalizedApi);
  return chunk?.flags ?? null;
}

export async function clearACUC(api_key: string): Promise<void> {
  // Clear both purpose-qualified keys and the legacy unqualified keys during
  // rollout so credential-purpose isolation cannot leave stale auth entries.
  const modes = [true, false];
  const credentialPurposes = ["general", "hosted_mcp_oauth"] as const;
  await Promise.all(
    modes.flatMap(mode => [
      deleteKey(`acuc_${api_key}_${mode ? "extract" : "scrape"}`),
      ...credentialPurposes.map(credentialPurpose =>
        deleteKey(
          `acuc_${credentialPurpose}_${api_key}_${mode ? "extract" : "scrape"}`,
        ),
      ),
    ]),
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

/**
 * Resolves the real client IP for keyless requests, trusting
 * `x-firecrawl-keyless-ip` only when `x-firecrawl-keyless-secret` matches.
 */
export function keylessClientIp(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}): string {
  let ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  if (
    timingSafeSecretEqual(
      req.headers["x-firecrawl-keyless-secret"],
      config.KEYLESS_PROXY_SECRET,
    )
  ) {
    const forwarded = req.headers["x-firecrawl-keyless-ip"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      ip = forwarded.trim();
    }
  }
  return ip;
}
