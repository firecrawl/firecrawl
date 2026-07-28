import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { getRedisConnection } from "../../services/queue-service";
import { logger as _logger } from "../logger";
import { decryptOrgSecret, encryptOrgSecret } from "../org-secret-crypto";
import type { OrgSiemLoggingConfig, SiemLoggingConfigInput } from "./types";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1000;
const ENABLED_CACHE_TTL_SECONDS = 60;
const logger = _logger.child({ module: "siem-logging-store" });
type SiemConfigRow = typeof schema.siem_logging_config.$inferSelect;

const configCache = new Map<
  string,
  { expiresAt: number; value: SiemConfigRow | null }
>();

function enabledCacheKey(orgId: string): string {
  return `{siemLoggingConfig:${orgId}}:enabled`;
}

const storedDestinationSchema = z.strictObject({
  type: z.literal("azure_sentinel"),
  tenantId: z.string(),
  clientId: z.string(),
  dceUrl: z.string(),
  dcrImmutableId: z.string(),
  streamName: z.string(),
});

function isMissingTableError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if ((current as { code?: unknown }).code === "42P01") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function rowToConfig(row: SiemConfigRow): OrgSiemLoggingConfig {
  const destination = storedDestinationSchema.parse(row.destination);
  return {
    orgId: row.org_id,
    enabled: row.enabled,
    destination: {
      ...destination,
      clientSecret: decryptOrgSecret(row.secret_ciphertext, row.org_id),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getCachedRow(orgId: string): SiemConfigRow | null | undefined {
  const cached = configCache.get(orgId);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    configCache.delete(orgId);
    return undefined;
  }
  configCache.delete(orgId);
  configCache.set(orgId, cached);
  return cached.value;
}

function cacheRow(orgId: string, value: SiemConfigRow | null): void {
  const now = Date.now();
  for (const [cachedOrgId, cached] of configCache) {
    if (cached.expiresAt <= now) configCache.delete(cachedOrgId);
  }
  configCache.delete(orgId);
  while (configCache.size >= CACHE_MAX_ENTRIES) {
    const oldestOrgId = configCache.keys().next().value;
    if (oldestOrgId === undefined) break;
    configCache.delete(oldestOrgId);
  }
  configCache.set(orgId, {
    expiresAt: now + CACHE_TTL_MS,
    value,
  });
}

export async function getOrgSiemLoggingConfig(
  orgId: string,
  options: { fresh?: boolean; primary?: boolean } = {},
): Promise<OrgSiemLoggingConfig | null> {
  const row = await getOrgSiemLoggingConfigRow(orgId, options);
  return row ? rowToConfig(row) : null;
}

async function getOrgSiemLoggingConfigRow(
  orgId: string,
  options: { fresh?: boolean; primary?: boolean } = {},
): Promise<SiemConfigRow | null> {
  if (!options.fresh) {
    const cached = getCachedRow(orgId);
    if (cached !== undefined) return cached;
  }

  let rows: SiemConfigRow[];
  try {
    rows = await (options.primary ? db : dbRr)
      .select()
      .from(schema.siem_logging_config)
      .where(eq(schema.siem_logging_config.org_id, orgId))
      .limit(1);
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    rows = [];
  }

  const row = rows[0] ?? null;
  cacheRow(orgId, row);
  return row;
}

export async function isOrgSiemLoggingEnabled(orgId: string): Promise<boolean> {
  const key = enabledCacheKey(orgId);
  const redis = getRedisConnection();
  const cached = await redis.get(key);
  if (cached !== null) return cached === "1";

  let rows: { enabled: boolean }[] = [];
  try {
    rows = await db
      .select({ enabled: schema.siem_logging_config.enabled })
      .from(schema.siem_logging_config)
      .where(eq(schema.siem_logging_config.org_id, orgId))
      .limit(1);
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }
  const enabled = rows[0]?.enabled === true;
  await redis.set(key, enabled ? "1" : "0", "EX", ENABLED_CACHE_TTL_SECONDS);
  return enabled;
}

export async function upsertOrgSiemLoggingConfig(
  orgId: string,
  input: SiemLoggingConfigInput,
): Promise<OrgSiemLoggingConfig> {
  const destination = {
    type: input.destination.type,
    tenantId: input.destination.tenantId,
    clientId: input.destination.clientId,
    dceUrl: input.destination.dceUrl.replace(/\/+$/, ""),
    dcrImmutableId: input.destination.dcrImmutableId,
    streamName: input.destination.streamName,
  };
  const existingRows = await db
    .select({
      secret_ciphertext: schema.siem_logging_config.secret_ciphertext,
    })
    .from(schema.siem_logging_config)
    .where(eq(schema.siem_logging_config.org_id, orgId))
    .limit(1);

  const existingCiphertext = existingRows[0]?.secret_ciphertext;
  if (!input.destination.clientSecret && !existingCiphertext) {
    throw new Error("clientSecret is required when SIEM is first configured");
  }

  const secretCiphertext = input.destination.clientSecret
    ? encryptOrgSecret(input.destination.clientSecret, orgId)
    : existingCiphertext!;
  const values = {
    org_id: orgId,
    enabled: input.enabled,
    destination,
    secret_ciphertext: secretCiphertext,
  };
  const [row] = await db
    .insert(schema.siem_logging_config)
    .values(values)
    .onConflictDoUpdate({
      target: schema.siem_logging_config.org_id,
      set: {
        enabled: values.enabled,
        destination: values.destination,
        secret_ciphertext: input.destination.clientSecret
          ? values.secret_ciphertext
          : sql`${schema.siem_logging_config.secret_ciphertext}`,
        updated_at: new Date().toISOString(),
      },
    })
    .returning();

  const updated = rowToConfig(row);
  cacheRow(orgId, row);
  await getRedisConnection()
    .set(
      enabledCacheKey(orgId),
      row.enabled ? "1" : "0",
      "EX",
      ENABLED_CACHE_TTL_SECONDS,
    )
    .catch(error => {
      logger.warn("Failed to update shared SIEM logging config cache", {
        error,
        orgId,
      });
    });
  return updated;
}

export async function getApiKeyName(
  teamId: string,
  apiKeyId: string | number | null | undefined,
): Promise<string | null> {
  if (apiKeyId == null) return null;
  const normalizedApiKeyId = String(apiKeyId);
  if (!/^\d+$/.test(normalizedApiKeyId)) return null;
  const rows = await dbRr
    .select({ name: schema.api_keys.name })
    .from(schema.api_keys)
    .where(
      and(
        sql`${schema.api_keys.id} = cast(${normalizedApiKeyId} as bigint)`,
        eq(schema.api_keys.team_id, teamId),
      ),
    )
    .limit(1);
  return rows[0]?.name ?? null;
}
