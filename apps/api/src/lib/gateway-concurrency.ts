import { eq } from "drizzle-orm";
import { config } from "../config";
import { dbRr } from "../db/connection";
import * as schema from "../db/schema";
import { getValue, setValue } from "../services/redis";
import { logger } from "./logger";

// Teams provisioned through a gateway partner integration ("ghosts") sit on
// the free plan, so Autumn grants them the plan default, while the partner
// funds their usage. This module derives a concurrency floor from the funding
// partner's organization instead:
//
//   * GATEWAY_GHOST_CONCURRENCY_CONTRACTED when that organization has a
//     signed contract on file (flags.signedContract),
//   * GATEWAY_GHOST_CONCURRENCY_SELF_SERVE otherwise.
//
// The figure is a floor, never a cap: callers combine it with the team's own
// Autumn value through withGatewayFloor, so it can only ever raise a team.

// Propagation delay for a partner org's signedContract flag or its
// gateway_enabled kill switch reaching that partner's ghosts.
const LIMIT_CACHE_TTL_SECONDS = 60;

// Cached negative: "not a gateway ghost" (or funding switched off), so the
// common case of an ordinary team skips the DB read too.
const NO_LIMIT = "none";

const limitCacheKey = (teamId: string) => `gateway-concurrency:${teamId}`;

/** The funding row behind a ghost: its integration's kill switch and funder. */
export type GatewayFundingRow = {
  gateway_enabled: boolean | null;
  partner_org_id: string | null;
  /** The funding partner's organizations.flags; null when the join found none. */
  partner_flags: unknown;
};

// Only the literal true counts. An absent key, a string "true" or a malformed
// bag is not a contract.
function readSignedContract(flags: unknown): boolean {
  return (
    typeof flags === "object" &&
    flags !== null &&
    !Array.isArray(flags) &&
    (flags as Record<string, unknown>).signedContract === true
  );
}

/**
 * The rule over a ghost's funding row. Null means "no gateway figure": the
 * team is not a gateway ghost, its partner has switched funding off
 * (gateway_enabled false drops the ghost back to its own plan), or the
 * integration names no partner org to fund from.
 */
export function resolveGatewayConcurrencyLimit(
  row: GatewayFundingRow | undefined,
): number | null {
  if (!row) return null;
  if (row.gateway_enabled !== true) return null;
  if (!row.partner_org_id) return null;
  return readSignedContract(row.partner_flags)
    ? config.GATEWAY_GHOST_CONCURRENCY_CONTRACTED
    : config.GATEWAY_GHOST_CONCURRENCY_SELF_SERVE;
}

/**
 * Combines a team's plan limit with its gateway figure. The gateway figure
 * only raises: a team with no gateway figure keeps its plan limit, and an
 * unlimited team (null, the forced-FDB "no Autumn value" case) stays
 * unlimited.
 */
export function withGatewayFloor(
  planLimit: number,
  gatewayLimit: number | null,
): number;
export function withGatewayFloor(
  planLimit: number | null,
  gatewayLimit: number | null,
): number | null;
export function withGatewayFloor(
  planLimit: number | null,
  gatewayLimit: number | null,
): number | null {
  if (planLimit === null || gatewayLimit === null) return planLimit;
  return Math.max(planLimit, gatewayLimit);
}

/**
 * The concurrent-browser figure a Gateway-provisioned team is entitled to
 * through its funding partner, or null when there is none (see
 * resolveGatewayConcurrencyLimit). Cached for a minute per team.
 *
 * Resolved through partner_provisioned_accounts -> user_referring_integration
 * -> organizations (the funding partner's row).
 *
 * Fails open to null: this is a raise, not a security boundary, so a DB or
 * cache blip leaves the ghost on its plan default for the next minute rather
 * than stalling enqueues. Failures are not cached.
 */
export async function getGatewayConcurrencyLimit(
  teamId: string,
): Promise<number | null> {
  // Without DB auth there are no partner tables to ask (self-hosted), and a
  // preview team is never partner-provisioned.
  if (config.USE_DB_AUTHENTICATION !== true) return null;
  if (teamId === "preview" || teamId.startsWith("preview_")) return null;

  const cacheKey = limitCacheKey(teamId);

  try {
    const cached = await getValue(cacheKey);
    if (cached !== null) {
      // Only the explicit sentinel means "no figure"; anything else malformed
      // is a miss so a corrupted entry cannot silently pin a ghost to 2.
      if (cached === NO_LIMIT) return null;
      const parsed = Number(cached);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
      logger.warn("Ignoring malformed gateway concurrency cache entry", {
        teamId,
      });
    }
  } catch (error) {
    logger.warn("Failed to read gateway concurrency cache", { teamId, error });
  }

  let limit: number | null;
  try {
    const [row] = await dbRr
      .select({
        gateway_enabled: schema.user_referring_integration.gateway_enabled,
        partner_org_id: schema.user_referring_integration.partner_org_id,
        partner_flags: schema.organizations.flags,
      })
      .from(schema.partner_provisioned_accounts)
      .innerJoin(
        schema.user_referring_integration,
        eq(
          schema.user_referring_integration.id,
          schema.partner_provisioned_accounts.integration_id,
        ),
      )
      .leftJoin(
        schema.organizations,
        eq(
          schema.organizations.id,
          schema.user_referring_integration.partner_org_id,
        ),
      )
      .where(eq(schema.partner_provisioned_accounts.team_id, teamId))
      .limit(1);
    limit = resolveGatewayConcurrencyLimit(row);
  } catch (error) {
    logger.warn("Failed to load gateway concurrency limit", { teamId, error });
    return null;
  }

  try {
    await setValue(
      cacheKey,
      String(limit ?? NO_LIMIT),
      LIMIT_CACHE_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn("Failed to cache gateway concurrency limit", { teamId, error });
  }

  return limit;
}
