import { RateLimiterMode } from "../types";
import { getACUCTeam } from "../controllers/auth";
import { redisEvictConnection } from "../services/redis";
import { logger } from "./logger";
import {
  autumnService,
  isAutumnLimitsEnabled,
} from "../services/autumn/autumn.service";
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
  basePriority = 10,
}: {
  team_id: string;
  basePriority?: number;
  from_extract?: boolean;
}): Promise<number> {
  if (team_id === "d97c4ceb-290b-4957-8432-2b2a02727d95") {
    return 50;
  }

  try {
    const acuc = await getACUCTeam(
      team_id,
      false,
      true,
      RateLimiterMode.Scrape,
    );

    const setKey = SET_KEY_PREFIX + team_id;

    // Get the length of the set
    const setLength = await redisEvictConnection.scard(setKey);

    // When the Autumn-limits ramp is enabled for the org, infer plan priority
    // from the rate-limit multiplier; otherwise use the ACUC plan_priority (the
    // old, default behavior).
    let bucketLimit: number;
    let planModifier: number;
    if (isAutumnLimitsEnabled(acuc?.org_id)) {
      const multiplier = await autumnService.getRateLimitMultiplier(
        team_id,
        acuc?.org_id,
      );
      ({ bucketLimit, planModifier } =
        inferPlanPriorityFromMultiplier(multiplier));
    } else {
      planModifier = acuc?.plan_priority.planModifier ?? 1;
      bucketLimit = acuc?.plan_priority.bucketLimit ?? 25;
    }

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
