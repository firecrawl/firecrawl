import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { deleteKey, getValue, setValue } from "../../services/redis";
import { logger as _logger } from "../logger";
import {
  THREAT_PROTECTION_POLICY_DEFAULTS,
  type ThreatProtectionPolicy,
} from "./types";
import type { ThreatProtectionConfigInput } from "./config";

const logger = _logger.child({ module: "threat-protection-store" });

// Short TTL so config changes apply without a redeploy while keeping the
// enforcement hot path off Postgres. Invalidated on write.
//
// ZDR boundary: this cache (and the team→org map below) stores the org's OWN
// configuration — never scrape-derived data (no target domains, URLs, or
// verdicts) — so it is compatible with zero-data-retention requirements and
// deliberately survives the removal of the verdict cache (ENG-5004).
const CACHE_TTL_SECONDS = 60;

const cacheKey = (orgId: string) => `threat-protection-config:${orgId}`;

/**
 * Whether an error is Postgres 42P01 (undefined_table) for our config table.
 * During the rollout window the enforcement code can be deployed before the
 * `threat_protection_config` DDL has been applied — in that case the feature
 * behaves as "not configured" instead of failing every flagged-team request.
 * Any other database error still propagates (we do NOT silently fail open on
 * transient failures).
 */
function isMissingTableError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === "42P01") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface OrgThreatProtectionConfig {
  orgId: string;
  policy: ThreatProtectionPolicy;
  allowRequestOverrides: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

type ThreatProtectionConfigRow =
  typeof schema.threat_protection_config.$inferSelect;

/**
 * Tolerant schema for the `config` jsonb document stored alongside `mode`.
 * The document is written exclusively by {@link upsertOrgThreatProtectionConfig}
 * (from API-validated input), but reads must survive anything: a missing or
 * partial document, unknown keys, or field-level garbage all fall back to the
 * field defaults instead of throwing — a bad row must never take down the
 * enforcement hot path.
 */
const storedConfigDocumentSchema = z
  .object({
    riskScoreThreshold: z
      .number()
      .int()
      .min(0)
      .max(100)
      .catch(THREAT_PROTECTION_POLICY_DEFAULTS.riskScoreThreshold),
    blacklist: z.array(z.string()).catch([]),
    whitelist: z.array(z.string()).catch([]),
    blockedTlds: z.array(z.string()).catch([]),
    failurePolicy: z
      .enum(["open", "closed"])
      .catch(THREAT_PROTECTION_POLICY_DEFAULTS.failurePolicy),
    allowRequestOverrides: z.boolean().catch(true),
  })
  .catch({
    ...THREAT_PROTECTION_POLICY_DEFAULTS,
    allowRequestOverrides: true,
  });

/**
 * Maps a `threat_protection_config` row (mode column + config jsonb document)
 * to the runtime config shape. Tolerant by construction: never throws, even
 * for empty/partial/unknown-keyed documents (see
 * {@link storedConfigDocumentSchema}). Exported for tests.
 */
export function rowToConfig(
  row: ThreatProtectionConfigRow,
): OrgThreatProtectionConfig {
  const doc = storedConfigDocumentSchema.parse(row.config ?? {});
  return {
    orgId: row.org_id,
    policy: {
      mode: row.mode === "normal" ? "normal" : "off",
      riskScoreThreshold: doc.riskScoreThreshold,
      blacklist: doc.blacklist,
      whitelist: doc.whitelist,
      blockedTlds: doc.blockedTlds,
      failurePolicy: doc.failurePolicy,
    },
    allowRequestOverrides: doc.allowRequestOverrides,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reads the org's threat protection config, with a short Redis cache
 * (~60s TTL, negative results included) so the enforcement hot path
 * doesn't hit Postgres per scrape. Invalidated by
 * {@link upsertOrgThreatProtectionConfig}.
 */
export async function getOrgThreatProtectionConfig(
  orgId: string,
): Promise<OrgThreatProtectionConfig | null> {
  const key = cacheKey(orgId);

  try {
    const cached = await getValue(key);
    if (cached !== null) {
      return JSON.parse(cached) as OrgThreatProtectionConfig | null;
    }
  } catch (error) {
    logger.warn("Failed to read threat protection config cache", {
      error,
      orgId,
    });
  }

  let rows: ThreatProtectionConfigRow[];
  try {
    rows = await dbRr
      .select()
      .from(schema.threat_protection_config)
      .where(eq(schema.threat_protection_config.org_id, orgId))
      .limit(1);
  } catch (error) {
    if (isMissingTableError(error)) {
      logger.warn(
        "threat_protection_config table does not exist yet; treating as unconfigured",
        { orgId },
      );
      rows = [];
    } else {
      throw error;
    }
  }

  const config = rows[0] ? rowToConfig(rows[0]) : null;

  try {
    await setValue(key, JSON.stringify(config), CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn("Failed to write threat protection config cache", {
      error,
      orgId,
    });
  }

  return config;
}

/**
 * Full-document upsert of the org's threat protection config. Invalidates
 * the read cache on success.
 */
export async function upsertOrgThreatProtectionConfig(
  orgId: string,
  config: ThreatProtectionConfigInput,
): Promise<OrgThreatProtectionConfig> {
  const values = {
    org_id: orgId,
    mode: config.mode,
    // Everything but the mode lives in the jsonb document.
    config: {
      riskScoreThreshold: config.riskScoreThreshold,
      blacklist: config.blacklist,
      whitelist: config.whitelist,
      blockedTlds: config.blockedTlds,
      failurePolicy: config.failurePolicy,
      allowRequestOverrides: config.allowRequestOverrides,
    },
  };

  const [row] = await db
    .insert(schema.threat_protection_config)
    .values(values)
    .onConflictDoUpdate({
      target: schema.threat_protection_config.org_id,
      set: {
        ...values,
        updated_at: new Date().toISOString(),
      },
    })
    .returning();

  try {
    await deleteKey(cacheKey(orgId));
  } catch (error) {
    logger.warn("Failed to invalidate threat protection config cache", {
      error,
      orgId,
    });
  }

  return rowToConfig(row);
}

/**
 * Resolves the org_id for a team. Used by the org-level config API when the
 * auth chunk doesn't carry org_id.
 */
export async function getOrgIdForTeam(teamId: string): Promise<string | null> {
  const rows = await dbRr
    .select({ org_id: schema.teams.org_id })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId))
    .limit(1);
  return rows[0]?.org_id ?? null;
}

/**
 * Computes the effective policy for a request.
 *
 * - No org config → mode "off" with defaults.
 * - A request override does field-level replacement on top of the org policy,
 *   unless the org locked overrides down (`allowRequestOverrides: false`),
 *   in which case it is ignored (the request should already have been
 *   rejected by `checkPermissions`; this is defense in depth).
 */
export function resolveEffectivePolicy(
  orgConfig: OrgThreatProtectionConfig | null,
  requestOverride?: Partial<ThreatProtectionPolicy>,
): ThreatProtectionPolicy {
  const base: ThreatProtectionPolicy = orgConfig
    ? { ...orgConfig.policy }
    : { mode: "off", ...THREAT_PROTECTION_POLICY_DEFAULTS };

  if (!requestOverride || (orgConfig && !orgConfig.allowRequestOverrides)) {
    return base;
  }

  for (const key of Object.keys(requestOverride) as Array<
    keyof ThreatProtectionPolicy
  >) {
    const value = requestOverride[key];
    if (value !== undefined) {
      (base as unknown as Record<string, unknown>)[key] = value;
    }
  }

  return base;
}
