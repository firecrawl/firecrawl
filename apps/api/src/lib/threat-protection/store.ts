import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { deleteKey, getValue, setValue } from "../../services/redis";
import { logger as _logger } from "../logger";
import { decryptOrgSecret, encryptOrgSecret } from "../org-secret-crypto";
import type { ZscalerCredentials } from "./providers/zscaler/client";
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

/**
 * Stored (non-secret-decrypted) Zscaler settings. `secretCiphertext` is the
 * AES-256-GCM output of the write-only client secret — decrypted only by
 * {@link getOrgZscalerCredentials} at call time, never serialized to the API
 * or into job payloads.
 */
export interface OrgZscalerSettings {
  clientId: string;
  secretCiphertext: string;
  vanityDomain: string;
  cloud: string | null;
  deniedCategories: string[];
  syncIntervalMinutes: number;
}

export interface OrgThreatProtectionConfig {
  orgId: string;
  policy: ThreatProtectionPolicy;
  allowRequestOverrides: boolean;
  zscaler: OrgZscalerSettings | null;
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
const storedZscalerSchema = z
  .object({
    clientId: z.string().min(1),
    secretCiphertext: z.string().min(1),
    vanityDomain: z.string().min(1),
    cloud: z.string().nullable().catch(null),
    deniedCategories: z.array(z.string()).catch([]),
    syncIntervalMinutes: z.number().int().positive().catch(60),
  })
  // A malformed block degrades to "no Zscaler connection" (lookups then fail
  // per the org's failurePolicy) instead of throwing on the hot path.
  .nullable()
  .catch(null);

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
    zscaler: storedZscalerSchema.optional().catch(null),
  })
  .catch({
    ...THREAT_PROTECTION_POLICY_DEFAULTS,
    allowRequestOverrides: true,
    zscaler: null,
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
  const zscaler = doc.zscaler ?? null;
  return {
    orgId: row.org_id,
    policy: {
      mode:
        row.mode === "normal"
          ? "normal"
          : row.mode === "zscaler"
            ? "zscaler"
            : "off",
      riskScoreThreshold: doc.riskScoreThreshold,
      blacklist: doc.blacklist,
      whitelist: doc.whitelist,
      blockedTlds: doc.blockedTlds,
      failurePolicy: doc.failurePolicy,
      ...(zscaler
        ? {
            zscaler: {
              orgId: row.org_id,
              deniedCategories: zscaler.deniedCategories,
              syncIntervalMinutes: zscaler.syncIntervalMinutes,
            },
          }
        : {}),
    },
    allowRequestOverrides: doc.allowRequestOverrides,
    zscaler,
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
 * The PUT config document needs a client secret we do not have: thrown when a
 * Zscaler block is first configured without one, or when the client ID
 * changes without a matching new secret. Mapped to a 400 by the controller.
 */
export class ZscalerSecretRequiredError extends Error {
  constructor() {
    super(
      "zscaler.clientSecret is required when configuring a Zscaler connection or changing its client ID",
    );
    this.name = "ZscalerSecretRequiredError";
  }
}

/**
 * Full-document upsert of the org's threat protection config. Invalidates
 * the read cache on success.
 *
 * The Zscaler client secret is write-only: when the input block omits it,
 * the stored ciphertext is kept — but only while the client ID is unchanged
 * (pairing a new client with an old secret is always a mistake, so that
 * throws {@link ZscalerSecretRequiredError} instead).
 */
export async function upsertOrgThreatProtectionConfig(
  orgId: string,
  config: ThreatProtectionConfigInput,
): Promise<OrgThreatProtectionConfig> {
  let zscaler: z.infer<typeof storedZscalerSchema> = null;
  if (config.zscaler) {
    let secretCiphertext: string;
    if (config.zscaler.clientSecret) {
      secretCiphertext = encryptOrgSecret(config.zscaler.clientSecret, orgId);
    } else {
      // Primary read: the upsert below writes to the primary, and a stale
      // replica must not make us discard a just-saved secret.
      const existingRows = await db
        .select({ config: schema.threat_protection_config.config })
        .from(schema.threat_protection_config)
        .where(eq(schema.threat_protection_config.org_id, orgId))
        .limit(1);
      const existing = existingRows[0]
        ? storedConfigDocumentSchema.parse(existingRows[0].config ?? {}).zscaler
        : null;
      if (!existing || existing.clientId !== config.zscaler.clientId) {
        throw new ZscalerSecretRequiredError();
      }
      secretCiphertext = existing.secretCiphertext;
    }
    zscaler = {
      clientId: config.zscaler.clientId,
      secretCiphertext,
      vanityDomain: config.zscaler.vanityDomain,
      cloud: config.zscaler.cloud,
      deniedCategories: config.zscaler.deniedCategories,
      syncIntervalMinutes: config.zscaler.syncIntervalMinutes,
    };
  }

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
      zscaler,
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
  // Omit is deliberate: the Zscaler connection is org-owned and never
  // request-settable — passing one is a compile error, not an ignored field.
  requestOverride?: Partial<Omit<ThreatProtectionPolicy, "zscaler">>,
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
    // The Zscaler connection settings come from the org config only — the
    // override schema has no such field, and this guard keeps it that way
    // even if a wider Partial ever reaches here.
    if (key === "zscaler") continue;
    const value = requestOverride[key];
    if (value !== undefined) {
      (base as unknown as Record<string, unknown>)[key] = value;
    }
  }

  return base;
}

/**
 * Decrypted Zscaler API credentials for an org, or null when the org has no
 * (valid) Zscaler connection. Backed by the 60s org-config cache, so a saved
 * secret rotation is picked up within a minute — the plaintext itself lives
 * only in this return value, never in a cache or a job payload.
 */
export async function getOrgZscalerCredentials(
  orgId: string,
): Promise<ZscalerCredentials | null> {
  const orgConfig = await getOrgThreatProtectionConfig(orgId);
  if (!orgConfig?.zscaler) return null;
  try {
    return {
      clientId: orgConfig.zscaler.clientId,
      clientSecret: decryptOrgSecret(orgConfig.zscaler.secretCiphertext, orgId),
      vanityDomain: orgConfig.zscaler.vanityDomain,
      cloud: orgConfig.zscaler.cloud,
    };
  } catch (error) {
    logger.error("Failed to decrypt the stored Zscaler client secret", {
      error,
      orgId,
    });
    return null;
  }
}
