import { BlockList, isIP } from "node:net";
import { eq } from "drizzle-orm";
import { dbRr } from "../db/connection";
import * as schema from "../db/schema";
import { deleteKey, getValue, setValue } from "../services/redis";
import { logger } from "./logger";
import type { TeamFlags } from "../controllers/v1/types";

// Propagation delay for dashboard edits to ip_restriction_config.
const ALLOWLIST_CACHE_TTL_SECONDS = 60;

const allowlistCacheKey = (teamId: string) =>
  `ip-restriction-allowlist:${teamId}`;

// Invalidates the cached allowlist so dashboard edits apply immediately
// (admin route ip-restriction-cache-clear).
export async function clearIpRestrictionCache(teamId: string): Promise<void> {
  await deleteKey(allowlistCacheKey(teamId));
}

// Express hands IPv4 clients back as IPv4-mapped IPv6 (::ffff:1.2.3.4) when
// the socket is dual-stack; compare in IPv4 form so allowlist entries match.
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4) {
    return trimmed.slice(7);
  }
  return trimmed;
}

export function isIpAllowed(rawIp: string, allowedIps: string[]): boolean {
  const ip = normalizeIp(rawIp);
  const ipVersion = isIP(ip);
  if (ipVersion === 0) {
    return false;
  }

  const list = new BlockList();
  for (const rawEntry of allowedIps) {
    if (typeof rawEntry !== "string") continue;
    const entry = normalizeIp(rawEntry);
    const slash = entry.indexOf("/");
    // Malformed entries are skipped rather than thrown on: the list is
    // validated on write, but a bad entry must never disable the others.
    try {
      if (slash === -1) {
        const version = isIP(entry);
        if (version === 0) continue;
        list.addAddress(entry, version === 6 ? "ipv6" : "ipv4");
      } else {
        const address = entry.slice(0, slash);
        const prefix = Number(entry.slice(slash + 1));
        const version = isIP(address);
        if (version === 0 || !Number.isInteger(prefix)) continue;
        if (prefix < 0 || prefix > (version === 6 ? 128 : 32)) continue;
        list.addSubnet(address, prefix, version === 6 ? "ipv6" : "ipv4");
      }
    } catch {
      continue;
    }
  }

  return list.check(ip, ipVersion === 6 ? "ipv6" : "ipv4");
}

async function getTeamAllowedIps(teamId: string): Promise<string[]> {
  const cacheKey = allowlistCacheKey(teamId);

  try {
    const cached = await getValue(cacheKey);
    if (cached !== null) {
      const parsed = JSON.parse(cached);
      // A corrupted-but-parseable cache entry must not reach the matcher;
      // treat anything that isn't a string array as a cache miss.
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string");
      }
      logger.warn("Ignoring malformed IP restriction allowlist cache entry", {
        teamId,
      });
    }
  } catch (error) {
    logger.warn("Failed to read IP restriction allowlist cache", {
      teamId,
      error,
    });
  }

  const [row] = await dbRr
    .select({ allowed_ips: schema.ip_restriction_config.allowed_ips })
    .from(schema.ip_restriction_config)
    .where(eq(schema.ip_restriction_config.team_id, teamId))
    .limit(1);

  const allowedIps = Array.isArray(row?.allowed_ips)
    ? (row.allowed_ips as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];

  try {
    await setValue(
      cacheKey,
      JSON.stringify(allowedIps),
      ALLOWLIST_CACHE_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn("Failed to cache IP restriction allowlist", { teamId, error });
  }

  return allowedIps;
}

type IpRestrictionResult =
  | { allowed: true }
  | { allowed: false; error: string; status: number };

/**
 * Enforces the per-team API key IP allowlist (ip_restriction_config table),
 * gated by the ipRestriction team flag. An empty or missing allowlist means
 * no restriction, so a team can't lock itself out before configuring IPs.
 */
export async function checkIpRestriction(
  clientIp: string | undefined,
  teamId: string,
  flags: TeamFlags,
): Promise<IpRestrictionResult> {
  if (!flags?.ipRestriction) {
    return { allowed: true };
  }

  let allowedIps: string[];
  try {
    allowedIps = await getTeamAllowedIps(teamId);
  } catch (error) {
    logger.error("Failed to load IP restriction allowlist", { teamId, error });
    // Fail closed: the team explicitly opted into IP restriction, so an
    // unverifiable IP must not slip through.
    return {
      allowed: false,
      error:
        "Internal error while verifying this team's IP restriction. Please try again shortly.",
      status: 500,
    };
  }

  if (allowedIps.length === 0) {
    return { allowed: true };
  }

  if (clientIp && isIpAllowed(clientIp, allowedIps)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: `Request blocked: IP address ${clientIp ? normalizeIp(clientIp) : "unknown"} is not on this team's allowed IP list. Team admins can manage allowed IPs at https://www.firecrawl.dev/app/enterprise-controls?tab=ip-restriction`,
    status: 403,
  };
}
