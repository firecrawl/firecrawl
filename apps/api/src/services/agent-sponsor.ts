import { logger } from "../lib/logger";
import { deleteKey, getValue, setValue } from "./redis";
import {
  isPostgrestNoRowsError,
  supabase_rr_service,
  supabase_service,
} from "./supabase";

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
    const { data, error } = await supabase_rr_service
      .from("agent_sponsors")
      .select("status, verification_deadline, email")
      .eq("api_key_id", apiKeyId)
      .single();

    if (error) {
      // Only cache "no sponsor" when it's a confirmed no-rows result.
      // Do not cache on other errors (e.g. connection/timeout) so we retry on next request.
      if (isPostgrestNoRowsError(error)) {
        await setValue(
          cacheKey,
          JSON.stringify(CACHE_MISS_SENTINEL),
          AGENT_SPONSOR_CACHE_TTL,
        );
      } else {
        logger.error("Failed to look up agent sponsor status", {
          apiKeyId,
          error,
        });
      }
      return null;
    }
    if (!data) {
      return null;
    }

    const result: AgentSponsorStatus = {
      status: data.status,
      verification_deadline: data.verification_deadline,
      email: data.email,
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
export async function clearAgentSponsorCache({
  apiKeyId,
}: {
  apiKeyId: number;
}): Promise<void> {
  await deleteKey(`agent_sponsor_${apiKeyId}`);
}

/**
 * Look up agent sponsor record by verification token.
 */
export async function getAgentSponsorByToken({
  agent_signup_token,
}: {
  agent_signup_token: string;
}): Promise<{
  id: number;
  email: string;
  status: string;
  verification_deadline: string;
  agent_name: string;
  sandboxed_team_id: string;
  api_key_id: number;
} | null> {
  const { data, error } = await supabase_service
    .from("agent_sponsors")
    .select(
      "id, email, status, verification_deadline, agent_name, sandboxed_team_id, api_key_id",
    )
    .eq("verification_token", agent_signup_token)
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}

/**
 * Mark sponsor as verified and set verified_at timestamp.
 */
export async function markSponsorVerified({
  sponsorId,
}: {
  sponsorId: number;
}): Promise<void> {
  const { error } = await supabase_service
    .from("agent_sponsors")
    .update({ status: "verified", verified_at: new Date().toISOString() })
    .eq("id", sponsorId);

  if (error) {
    logger.error("Failed to mark sponsor as verified", { sponsorId, error });
    throw error;
  }
}

/**
 * Mark sponsor as blocked.
 */
export async function markSponsorBlocked({
  sponsorId,
}: {
  sponsorId: number;
}): Promise<void> {
  const { error } = await supabase_service
    .from("agent_sponsors")
    .update({ status: "blocked" })
    .eq("id", sponsorId);

  if (error) {
    logger.error("Failed to mark sponsor as blocked", { sponsorId, error });
    throw error;
  }
}
