import { redisEvictConnection } from "../services/redis";
import { logger } from "./logger";
import type { AuthCreditUsageChunkFromTeam } from "../controllers/v1/types";
import { resolveJobPriority } from "./limits";
import { requestContext } from "./request-context";

const SET_KEY_PREFIX = "limit_team_id:";

export async function addJobPriority(team_id: string, job_id: string) {
  try {
    const setKey = SET_KEY_PREFIX + team_id;

    // Add scrape job id to the set
    await redisEvictConnection.sadd(setKey, job_id);

    // This approach will reset the expiration time to 60 seconds every time a new job is added to the set.
    await redisEvictConnection.expire(setKey, 60);
  } catch (e) {
    logger.error(`Add job priority (sadd) failed: ${team_id}, ${job_id}`);
  }
}

export async function deleteJobPriority(team_id: string, job_id: string) {
  try {
    const setKey = SET_KEY_PREFIX + team_id;

    // remove job_id from the set
    await redisEvictConnection.srem(setKey, job_id);
  } catch (e) {
    logger.error(`Delete job priority (srem) failed: ${team_id}, ${job_id}`);
  }
}

/** Returns the count of recent jobs tracked for priority calculation for `team_id`. */
export async function getJobPriorityActiveCount(
  team_id: string,
): Promise<number> {
  return await redisEvictConnection.scard(SET_KEY_PREFIX + team_id);
}

export async function getJobPriority({
  team_id,
  acuc,
  basePriority = 10,
}: {
  team_id: string;
  /** The team's ACUC, when the caller holds one. */
  acuc?: AuthCreditUsageChunkFromTeam | null;
  basePriority?: number;
  from_extract?: boolean;
}): Promise<number> {
  const ctx = requestContext({
    teamId: team_id,
    zeroDataRetention: false,
    flags: acuc?.flags,
    orgId: acuc?.org_id,
    apiKeyId: acuc?.api_key_id,
    concurrencyLimit: acuc?.concurrency_limit,
    rateLimitMultiplier: acuc?.rate_limit_multiplier,
  });
  return await resolveJobPriority(ctx, basePriority, error => {
    logger.error("Get job priority failed", {
      teamId: team_id,
      basePriority,
      error,
    });
  });
}
