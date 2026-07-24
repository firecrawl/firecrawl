import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { decryptSiemSecret, encryptSiemSecret } from "./crypto";
import type { OrgSiemAuditConfig, SiemAuditConfigInput } from "./types";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1000;
type SiemConfigRow = typeof schema.siem_audit_config.$inferSelect;

const configCache = new Map<
  string,
  { expiresAt: number; value: SiemConfigRow | null }
>();

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

function rowToConfig(row: SiemConfigRow): OrgSiemAuditConfig {
  const destination = storedDestinationSchema.parse(row.destination);
  return {
    orgId: row.org_id,
    enabled: row.enabled,
    destination: {
      ...destination,
      clientSecret: decryptSiemSecret(row.secret_ciphertext, row.org_id),
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

export async function getOrgSiemAuditConfig(
  orgId: string,
): Promise<OrgSiemAuditConfig | null> {
  const cached = getCachedRow(orgId);
  if (cached !== undefined) return cached ? rowToConfig(cached) : null;

  let rows: SiemConfigRow[];
  try {
    rows = await dbRr
      .select()
      .from(schema.siem_audit_config)
      .where(eq(schema.siem_audit_config.org_id, orgId))
      .limit(1);
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    rows = [];
  }

  const row = rows[0] ?? null;
  cacheRow(orgId, row);
  return row ? rowToConfig(row) : null;
}

export async function upsertOrgSiemAuditConfig(
  orgId: string,
  input: SiemAuditConfigInput,
): Promise<OrgSiemAuditConfig> {
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
      secret_ciphertext: schema.siem_audit_config.secret_ciphertext,
    })
    .from(schema.siem_audit_config)
    .where(eq(schema.siem_audit_config.org_id, orgId))
    .limit(1);

  const existingCiphertext = existingRows[0]?.secret_ciphertext;
  if (!input.destination.clientSecret && !existingCiphertext) {
    throw new Error("clientSecret is required when SIEM is first configured");
  }

  const secretCiphertext = input.destination.clientSecret
    ? encryptSiemSecret(input.destination.clientSecret, orgId)
    : existingCiphertext!;
  const values = {
    org_id: orgId,
    enabled: input.enabled,
    destination,
    secret_ciphertext: secretCiphertext,
  };
  const [row] = await db
    .insert(schema.siem_audit_config)
    .values(values)
    .onConflictDoUpdate({
      target: schema.siem_audit_config.org_id,
      set: {
        enabled: values.enabled,
        destination: values.destination,
        secret_ciphertext: input.destination.clientSecret
          ? values.secret_ciphertext
          : sql`${schema.siem_audit_config.secret_ciphertext}`,
        updated_at: new Date().toISOString(),
      },
    })
    .returning();

  const updated = rowToConfig(row);
  cacheRow(orgId, row);
  return updated;
}

export async function getApiKeyName(
  teamId: string,
  apiKeyId: string | number | null | undefined,
): Promise<string | null> {
  if (apiKeyId == null) return null;
  const apiKeyIdText = String(apiKeyId);
  if (!/^\d+$/.test(apiKeyIdText)) return null;
  const rows = await dbRr
    .select({ name: schema.api_keys.name })
    .from(schema.api_keys)
    .where(
      and(
        sql`${schema.api_keys.id} = cast(${apiKeyIdText} as bigint)`,
        eq(schema.api_keys.team_id, teamId),
      ),
    )
    .limit(1);
  return rows[0]?.name ?? null;
}
