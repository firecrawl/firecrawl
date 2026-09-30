import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { JWTVerifyGetKey } from "jose";
import { db, dbRr } from "../db/connection";
import * as schema from "../db/schema";
import { logger } from "../lib/logger";
import {
  createVercelJwks,
  VercelOidcTokenInvalidError,
  vercelIssuer,
  verifyVercelOidcToken,
} from "../lib/vercel-marketplace-oidc";
import { getValue, setValue } from "./redis";

const MAX_POSITIVE_CACHE_TTL_SECONDS = 300;
const NEGATIVE_CACHE_TTL_SECONDS = 60;

export type VercelOidcResolution =
  | {
      ok: true;
      // api_keys.key (uuid form), fed to the regular ACUC lookup.
      apiKey: string;
      // vercel_marketplace_resources.team_id; the caller checks it against the
      // key's team.
      teamId: string;
      installationId: string;
      resourceId: string;
    }
  | { ok: false; reason: string };

const jwksByIntegration = new Map<string, JWTVerifyGetKey>();

function jwksFor(integrationId: string): JWTVerifyGetKey {
  let getKey = jwksByIntegration.get(integrationId);
  if (!getKey) {
    getKey = createVercelJwks(`${vercelIssuer(integrationId)}/jwks.json`);
    jwksByIntegration.set(integrationId, getKey);
  }
  return getKey;
}

function cacheKey(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex");
  return `vercel_oidc_token:${hash.slice(0, 32)}`;
}

async function readCache(key: string): Promise<VercelOidcResolution | null> {
  try {
    const cached = await getValue(key);
    if (cached === null) return null;
    const parsed = JSON.parse(cached) as VercelOidcResolution;
    if (parsed.ok === false) return parsed;
    if (
      parsed.ok === true &&
      typeof parsed.apiKey === "string" &&
      typeof parsed.teamId === "string"
    ) {
      return parsed;
    }
  } catch (error) {
    // Redis and malformed entries are treated as misses; verification stays
    // authoritative.
    logger.warn("Vercel OIDC token cache read failed", { error });
  }
  return null;
}

async function writeCache(
  key: string,
  value: VercelOidcResolution,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds <= 0) return;
  try {
    await setValue(key, JSON.stringify(value), ttlSeconds);
  } catch (error) {
    logger.warn("Vercel OIDC token cache write failed", { error });
  }
}

async function lookupResource(installationId: string, resourceId: string) {
  const query = (database: typeof db) =>
    database
      .select({
        teamId: schema.vercel_marketplace_resources.team_id,
        apiKey: schema.api_keys.key,
      })
      .from(schema.vercel_marketplace_resources)
      .leftJoin(
        schema.api_keys,
        eq(schema.api_keys.id, schema.vercel_marketplace_resources.api_key_id),
      )
      .where(
        and(
          eq(
            schema.vercel_marketplace_resources.installation_id,
            installationId,
          ),
          eq(schema.vercel_marketplace_resources.resource_id, resourceId),
        ),
      )
      .limit(1);

  // The replica serves the steady state. A miss re-reads the primary so a
  // resource provisioned moments ago is not negatively cached through replica
  // lag.
  const [replicaRow] = await query(dbRr);
  if (replicaRow?.apiKey) return replicaRow;
  const [primaryRow] = await query(db);
  return primaryRow;
}

/**
 * Resolves a Vercel Marketplace OIDC resource token to the API key issued for
 * that resource. Verified resolutions are cached by token hash until the token
 * expires (at most 5 minutes); rejections are cached for a minute.
 *
 * Throws VercelJwksUnavailableError when no usable signing keys are available.
 */
export async function resolveVercelOidcToken(
  token: string,
  integrationId: string,
): Promise<VercelOidcResolution> {
  const key = cacheKey(token);
  const cached = await readCache(key);
  if (cached) return cached;

  let claims;
  try {
    claims = await verifyVercelOidcToken(token, {
      integrationId,
      getKey: jwksFor(integrationId),
    });
  } catch (error) {
    if (error instanceof VercelOidcTokenInvalidError) {
      const rejected = { ok: false as const, reason: error.reason };
      logger.warn("Vercel OIDC token rejected", { reason: error.reason });
      await writeCache(key, rejected, NEGATIVE_CACHE_TTL_SECONDS);
      return rejected;
    }
    throw error;
  }

  const audit = {
    installationId: claims.aud,
    resourceId: claims.resource,
    sub: claims.sub,
    owner: claims.owner,
    project: claims.project,
    environment: claims.environment,
  };

  const row = await lookupResource(claims.aud, claims.resource);
  if (!row || !row.apiKey || !row.teamId) {
    const rejected = {
      ok: false as const,
      reason: !row
        ? "unknown_resource"
        : !row.apiKey
          ? "resource_has_no_key"
          : "resource_has_no_team",
    };
    logger.warn("Vercel OIDC token rejected", {
      ...audit,
      reason: rejected.reason,
    });
    await writeCache(key, rejected, NEGATIVE_CACHE_TTL_SECONDS);
    return rejected;
  }

  const resolution = {
    ok: true as const,
    apiKey: row.apiKey,
    teamId: row.teamId,
    installationId: claims.aud,
    resourceId: claims.resource,
  };
  logger.info("Vercel OIDC token verified", { ...audit, teamId: row.teamId });

  await writeCache(
    key,
    resolution,
    Math.min(
      claims.exp - Math.floor(Date.now() / 1000),
      MAX_POSITIVE_CACHE_TTL_SECONDS,
    ),
  );
  return resolution;
}
