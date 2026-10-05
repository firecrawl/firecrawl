import { redisEvictConnection } from "../services/redis";
import { logger } from "./logger";
import { autumnService } from "../services/autumn/autumn.service";
import { acucEntityLimitsCache } from "../controllers/auth";
import type { AuthCreditUsageChunkFromTeam } from "../controllers/v1/types";
import { inferPlanPriorityFromMultiplier } from "../services/rate-limiter";

const SET_KEY_PREFIX = "limit_team_id:";
export async function addJobPriority(team_id, job_id) {
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

export async function deleteJobPriority(team_id, job_id) {
  try {
    const setKey = SET_KEY_PREFIX + team_id;

    // remove job_id from the set
    await redisEvictConnection.srem(setKey, job_id);
  } catch (e) {
    logger.error(`Delete job priority (srem) failed: ${team_id}, ${job_id}`);
  }
}

export async function getJobPriority({
  team_id,
  org_id,
  acuc,
  basePriority = 10,
}: {
  team_id: string;
  /** The team's org, from the ACUC the caller already holds. Required so a
   * caller cannot silently omit it and fall back to the high fail-open
   * limits; pass null only when the caller genuinely has no org. */
  org_id: string | null;
  /** The team's ACUC, when the caller holds one: its cached limits save a
   * read of the team's ACUC on every call. */
  acuc?: AuthCreditUsageChunkFromTeam | null;
  basePriority?: number;
  from_extract?: boolean;
}): Promise<number> {
  if (team_id === "d97c4ceb-290b-4957-8432-2b2a02727d95") {
    return 50;
  }

  try {
    const setKey = SET_KEY_PREFIX + team_id;

    // Get the length of the set
    const setLength = await redisEvictConnection.scard(setKey);

    // Plan priority is inferred from the team's Autumn rate-limit multiplier.
    // The org and ACUC are threaded in by the caller: this runs once per
    // discovered link inside a crawl, so it must not do an ACUC lookup of its
    // own when the caller holds one.
    const multiplier = await autumnService.getRateLimitMultiplier(
      team_id,
      org_id,
      acucEntityLimitsCache(acuc),
    );
    const { bucketLimit, planModifier } =
      inferPlanPriorityFromMultiplier(multiplier);

    // if length set is smaller than set, just return base priority
    if (setLength <= bucketLimit) {
      return basePriority;
    } else {
      // If not, we keep base priority + planModifier
      return Math.ceil(
        basePriority + Math.ceil((setLength - bucketLimit) * planModifier),
      );
    }
  } catch (e) {
    logger.error(`Get job priority failed: ${team_id}, ${basePriority}`);
    return basePriority;
  }
}
