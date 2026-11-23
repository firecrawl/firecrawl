import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getValue, setValue } from "./redis";
import { dbRr } from "../db/connection";
import * as schema from "../db/schema";

type AgentSponsorStatus = {
  status: "pending" | "verified" | "blocked";
  verification_deadline: string;
  email: string;
};

/** Value stored in Redis: either sponsor data or a sentinel for "no sponsor". */
type AgentSponsorCacheValue = AgentSponsorStatus | { _none: true };

const AGENT_SPONSOR_CACHE_TTL = 300; // 5 minutes

const CACHE_MISS_SENTINEL: AgentSponsorCacheValue = { _none: true };

/**
 * Look up agent sponsor status by api_key_id with Redis caching.
 */
export async function getAgentSponsorStatus({
  apiKeyId,
}: {
  apiKeyId: number;
}): Promise<AgentSponsorStatus | null> {
  const cacheKey = `agent_sponsor_${apiKeyId}`;

  const cached: string | null = await getValue(cacheKey);
  if (cached !== null) {
    try {
      const parsed = JSON.parse(cached) as AgentSponsorCacheValue;
      // Cache "no sponsor" as empty object
      if (parsed && "_none" in parsed && parsed._none) return null;
      return parsed as AgentSponsorStatus;
    } catch {
      // Corrupt cache: fall through to DB lookup
    }
  }

  try {
    const [data] = await dbRr
      .select({
        status: schema.agent_sponsors.status,
        verification_deadline: schema.agent_sponsors.verification_deadline,
        email: schema.agent_sponsors.email,
      })
      .from(schema.agent_sponsors)
      .where(eq(schema.agent_sponsors.api_key_id, apiKeyId))
      .limit(1);

    if (!data) {
      // Confirmed no-rows result — cache the "no sponsor" sentinel.
      await setValue(
        cacheKey,
        JSON.stringify(CACHE_MISS_SENTINEL),
        AGENT_SPONSOR_CACHE_TTL,
      );
      return null;
    }

    const result: AgentSponsorStatus = {
      status: data.status as AgentSponsorStatus["status"],
      verification_deadline: data.verification_deadline!,
      email: data.email!,
    };

    await setValue(cacheKey, JSON.stringify(result), AGENT_SPONSOR_CACHE_TTL);
    return result;
  } catch (err) {
    logger.error("Failed to look up agent sponsor status", {
      apiKeyId,
      error: err,
    });
    return null;
  }
}
