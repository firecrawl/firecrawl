import { asc, eq } from "drizzle-orm";
import { dbRr } from "../db/connection";
import * as schema from "../db/schema";
import { getValue, setValue } from "../services/redis";
import { logger } from "./logger";
import { countries } from "./validate-country";

const CACHE_TTL_SECONDS = 60 * 60;
const LOOKUP_TIMEOUT_MS = 1000;
const cacheKey = (teamId: string) => `billing-country:${teamId}`;

async function resolve(teamId: string): Promise<string | undefined> {
  const cached = await getValue(cacheKey(teamId));
  if (cached !== null) return cached || undefined;

  const rows = await dbRr
    .select({ billing_address: schema.users.billing_address })
    .from(schema.user_teams)
    .innerJoin(schema.users, eq(schema.user_teams.user_id, schema.users.id))
    .where(eq(schema.user_teams.team_id, teamId))
    .orderBy(asc(schema.user_teams.created_at));

  let country = "";
  for (const row of rows) {
    const candidate = (row.billing_address as { country?: unknown } | null)
      ?.country;
    if (typeof candidate !== "string") continue;
    const upper = candidate.trim().toUpperCase();
    if (!Object.hasOwn(countries, upper)) continue;
    country = upper;
    break;
  }

  await setValue(cacheKey(teamId), country, CACHE_TTL_SECONDS);
  return country || undefined;
}

/**
 * ISO 3166-1 alpha-2 country on the billing address of the team's longest-standing member that has
 * one (users.billing_address, copied from the card when a subscription is created), or undefined.
 * Cached per team. Any failure, or a lookup slower than LOOKUP_TIMEOUT_MS, reads as unknown.
 */
export async function billingCountryForTeam(
  teamId: string,
): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      resolve(teamId),
      new Promise<undefined>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(undefined), LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn("Failed to resolve the team's billing country", {
      teamId,
      error,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
