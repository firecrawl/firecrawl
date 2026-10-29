import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { deleteKey, getValue, setValue } from "./redis";
import { db, dbRr } from "../db/connection";
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

/**
 * Clear cached agent sponsor status for a given api_key_id.
 */
async function clearAgentSponsorCache({
  apiKeyId,
}: {
  apiKeyId: number;
}): Promise<void> {
  await deleteKey(`agent_sponsor_${apiKeyId}`);
}

/**
 * Look up agent sponsor record by verification token.
 */
async function getAgentSponsorByToken({
  agent_signup_token,
}: {
  agent_signup_token: string;
}): Promise<{
  id: number;
  email: string;
  status: string;
  verification_deadline: string;
  agent_name: string;
  sandboxed_team_id: string | null;
  api_key_id: number | null;
} | null> {
  try {
    const [data] = await db
      .select({
        id: schema.agent_sponsors.id,
        email: schema.agent_sponsors.email,
        status: schema.agent_sponsors.status,
        verification_deadline: schema.agent_sponsors.verification_deadline,
        agent_name: schema.agent_sponsors.agent_name,
        sandboxed_team_id: schema.agent_sponsors.sandboxed_team_id,
        api_key_id: schema.agent_sponsors.api_key_id,
      })
      .from(schema.agent_sponsors)
      .where(eq(schema.agent_sponsors.verification_token, agent_signup_token))
      .limit(1);

    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * Mark sponsor as verified and set verified_at timestamp.
 */
async function markSponsorVerified({
  sponsorId,
}: {
  sponsorId: number;
}): Promise<void> {
  try {
    await db
      .update(schema.agent_sponsors)
      .set({ status: "verified", verified_at: new Date().toISOString() })
      .where(eq(schema.agent_sponsors.id, sponsorId));
  } catch (error) {
    logger.error("Failed to mark sponsor as verified", { sponsorId, error });
    throw error;
  }
}

/**
 * Mark sponsor as blocked.
 */
async function markSponsorBlocked({
  sponsorId,
}: {
  sponsorId: number;
}): Promise<void> {
  try {
    await db
      .update(schema.agent_sponsors)
      .set({ status: "blocked" })
      .where(eq(schema.agent_sponsors.id, sponsorId));
  } catch (error) {
    logger.error("Failed to mark sponsor as blocked", { sponsorId, error });
    throw error;
  }
}
