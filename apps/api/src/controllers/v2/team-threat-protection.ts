import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { RequestWithAuth } from "./types";
import { getThreatProtection } from "../../lib/zdr-helpers";
import {
  threatProtectionConfigSchema,
  zscalerConfigSchema,
} from "../../lib/threat-protection/config";
import { THREAT_PROTECTION_CANNOT_TURN_OFF_MESSAGE } from "../../lib/threat-protection/request";
import {
  getOrgIdForTeam,
  getOrgThreatProtectionConfig,
  getOrgZscalerCredentials,
  resolveEffectivePolicy,
  upsertOrgThreatProtectionConfig,
  ZscalerSecretRequiredError,
  type OrgThreatProtectionConfig,
} from "../../lib/threat-protection/store";
import { zscalerTestConnection } from "../../lib/threat-protection/providers/zscaler/client";
import { consumeZscalerLookupBudget } from "../../lib/threat-protection/providers/zscaler/lookup-queue";
import {
  clearZscalerSyncState,
  consumeZscalerCategoriesBudget,
  getZscalerSyncDocument,
  syncOrgZscalerRules,
  type ZscalerSyncDocument,
} from "../../lib/threat-protection/providers/zscaler/sync";

const logger = _logger.child({ module: "team-threat-protection" });

const SUPPORT_EMAIL = "support@firecrawl.com";

function rejectWithoutFlag(
  req: RequestWithAuth<any, any, any>,
  res: Response,
): boolean {
  const mode = getThreatProtection(req.acuc?.flags);
  if (mode !== "allowed" && mode !== "forced") {
    res.status(403).json({
      success: false,
      error: `Threat protection is an enterprise feature and is not enabled for your team. Contact ${SUPPORT_EMAIL} to explore whether it can be enabled for your team.`,
    });
    return true;
  }
  return false;
}

async function resolveOrgId(
  req: RequestWithAuth<any, any, any>,
  res: Response,
): Promise<string | null> {
  const orgId = req.auth.org_id ?? (await getOrgIdForTeam(req.auth.team_id));
  if (!orgId) {
    logger.error("Failed to resolve org for team", {
      teamId: req.auth.team_id,
    });
    res.status(500).json({
      success: false,
      error: "Failed to resolve the organization for this team.",
    });
    return null;
  }
  return orgId;
}

/**
 * Dashboard view of the sync plane: last success, last attempt, staleness,
 * and the last failure. Derived from the synced document — no tenant call.
 */
function serializeSyncStatus(doc: ZscalerSyncDocument | null) {
  return {
    lastSyncedAt: doc?.syncedAt ?? null,
    lastAttemptedAt: doc?.attemptedAt ?? null,
    error: doc?.status === "error" ? doc.error : null,
    ruleCount: doc?.rules.length ?? 0,
    categoryCount: doc?.taxonomy.length ?? 0,
  };
}

/**
 * Effective config document served by GET and PUT. Always includes every
 * policy field (defaults applied), so the dashboard can render the form
 * without knowing the defaults. The Zscaler client secret is write-only and
 * never serialized; `hasClientSecret` tells the dashboard one is stored.
 */
function serializeConfig(
  orgConfig: OrgThreatProtectionConfig | null,
  syncDoc: ZscalerSyncDocument | null = null,
) {
  const { zscaler: _zscalerPolicy, ...policy } =
    resolveEffectivePolicy(orgConfig);
  return {
    ...policy,
    allowRequestOverrides: orgConfig?.allowRequestOverrides ?? true,
    zscaler: orgConfig?.zscaler
      ? {
          clientId: orgConfig.zscaler.clientId,
          hasClientSecret: true,
          vanityDomain: orgConfig.zscaler.vanityDomain,
          cloud: orgConfig.zscaler.cloud,
          deniedCategories: orgConfig.zscaler.deniedCategories,
          syncIntervalMinutes: orgConfig.zscaler.syncIntervalMinutes,
          syncStatus: serializeSyncStatus(syncDoc),
        }
      : null,
    configured: orgConfig !== null,
    updatedAt: orgConfig?.updatedAt ?? null,
  };
}

function changedFields(
  previous: OrgThreatProtectionConfig | null,
  next: OrgThreatProtectionConfig,
): string[] {
  const before = serializeConfig(previous) as Record<string, unknown>;
  const after = serializeConfig(next) as Record<string, unknown>;
  return Object.keys(after).filter(
    key =>
      key !== "updatedAt" &&
      key !== "configured" &&
      JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

export async function getTeamThreatProtectionController(
  req: RequestWithAuth,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;

  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;

  const orgConfig = await getOrgThreatProtectionConfig(orgId);
  const syncDoc = orgConfig?.zscaler
    ? await getZscalerSyncDocument(orgId)
    : null;

  res.status(200).json({
    success: true,
    data: serializeConfig(orgConfig, syncDoc),
  });
}

export async function putTeamThreatProtectionController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;

  const input = threatProtectionConfigSchema.parse(req.body);

  // "forced" guarantees enforcement: the org config may be tightened, but its
  // mode may never be turned off through the API.
  if (
    getThreatProtection(req.acuc?.flags) === "forced" &&
    input.mode === "off"
  ) {
    res.status(403).json({
      success: false,
      error: THREAT_PROTECTION_CANNOT_TURN_OFF_MESSAGE,
    });
    return;
  }

  if (input.mode === "zscaler" && !input.zscaler) {
    res.status(400).json({
      success: false,
      error:
        'Threat protection mode "zscaler" requires the zscaler connection block.',
    });
    return;
  }

  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;

  const previous = await getOrgThreatProtectionConfig(orgId);

  let updated: OrgThreatProtectionConfig;
  try {
    updated = await upsertOrgThreatProtectionConfig(orgId, input);
  } catch (error) {
    if (error instanceof ZscalerSecretRequiredError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    throw error;
  }

  // Keep the sync plane consistent with the connection: a removed connection
  // drops the synced rules, and so does a change of connection identity — the
  // old tenant's custom rules must not keep enforcing while the new tenant's
  // first sync runs. A (re)configured connection syncs in the background so
  // custom-list rules and the category picker are ready shortly after save.
  const connectionIdentityChanged =
    previous?.zscaler &&
    updated.zscaler &&
    (previous.zscaler.clientId !== updated.zscaler.clientId ||
      previous.zscaler.vanityDomain !== updated.zscaler.vanityDomain ||
      previous.zscaler.cloud !== updated.zscaler.cloud);
  if (previous?.zscaler && (!updated.zscaler || connectionIdentityChanged)) {
    await clearZscalerSyncState(orgId).catch(error => {
      logger.warn("Failed to clear Zscaler sync state", { error, orgId });
    });
  }
  if (updated.zscaler) {
    syncOrgZscalerRules(orgId).catch(error => {
      logger.warn("Background Zscaler sync after config save failed", {
        error,
        orgId,
      });
    });
  }

  // Audit log — org-level security configuration change. The serialized view
  // never carries the secret, so a rotation gets an explicit marker.
  const auditChangedFields = changedFields(previous, updated);
  if (input.zscaler?.clientSecret) {
    auditChangedFields.push("zscaler.clientSecret");
  }
  logger.info("Threat protection config updated", {
    teamId: req.auth.team_id,
    orgId,
    mode: updated.policy.mode,
    changedFields: auditChangedFields,
  });

  res.status(200).json({
    success: true,
    data: serializeConfig(
      updated,
      updated.zscaler ? await getZscalerSyncDocument(orgId) : null,
    ),
  });
}

// Connection test accepts either inline credentials (pre-save validation
// from the dashboard) or none (test the stored connection). The inline shape
// requires the secret — testing brand-new credentials without one is
// meaningless — except when the client ID matches the stored connection, in
// which case the stored secret fills in (dashboards round-trip the config
// without the write-only secret).
const testConnectionBodySchema = z
  .strictObject({
    zscaler: zscalerConfigSchema
      .pick({
        clientId: true,
        clientSecret: true,
        vanityDomain: true,
        cloud: true,
      })
      .optional(),
  })
  .optional();

export async function testTeamZscalerConnectionController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;

  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;

  // Primitive JSON bodies (0, false, "x") must not silently become "test the
  // stored connection" — only an object body (or none) is valid.
  if (
    req.body !== undefined &&
    (typeof req.body !== "object" ||
      req.body === null ||
      Array.isArray(req.body))
  ) {
    res.status(400).json({
      success: false,
      error: "The request body must be a JSON object.",
    });
    return;
  }
  const body = testConnectionBodySchema.parse(
    req.body && Object.keys(req.body as object).length > 0
      ? req.body
      : undefined,
  );

  const stored = await getOrgZscalerCredentials(orgId);
  let credentials = stored;
  if (body?.zscaler) {
    const inline = body.zscaler;
    let clientSecret = inline.clientSecret ?? null;
    if (!clientSecret && stored && stored.clientId === inline.clientId) {
      clientSecret = stored.clientSecret;
    }
    if (!clientSecret) {
      res.status(400).json({
        success: false,
        error:
          "zscaler.clientSecret is required to test credentials that are not stored yet",
      });
      return;
    }
    credentials = {
      clientId: inline.clientId,
      clientSecret,
      vanityDomain: inline.vanityDomain,
      cloud: inline.cloud,
    };
  }

  if (!credentials) {
    res.status(400).json({
      success: false,
      error:
        "No Zscaler connection is configured; provide credentials in the request body to test them.",
    });
    return;
  }

  // The probe spends one urlCategories call and one urlLookup call of the
  // tenant's quota. Each stage charges the shared budget right before its
  // own API call, so repeated tests can never starve real scrapes — and a
  // test that dies earlier (bad credentials) spends nothing.
  const result = await zscalerTestConnection(credentials, {
    signal: AbortSignal.timeout(30_000),
    beforeCategories: () => consumeZscalerCategoriesBudget(credentials),
    beforeLookup: () => consumeZscalerLookupBudget(credentials),
  });

  logger.info("Zscaler connection test", {
    teamId: req.auth.team_id,
    orgId,
    ok: result.ok,
    tokenOk: result.tokenOk,
    categoriesOk: result.categoriesOk,
    lookupOk: result.lookupOk,
    errorKind: result.error?.kind ?? null,
  });

  res.status(200).json({ success: true, data: result });
}

/**
 * Category taxonomy for the dashboard's denied-categories picker: Zscaler-
 * defined and custom categories, from the synced document. Syncs inline
 * when no document exists yet (first visit after connecting).
 */
export async function getTeamZscalerCategoriesController(
  req: RequestWithAuth,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;

  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;

  const orgConfig = await getOrgThreatProtectionConfig(orgId);
  if (!orgConfig?.zscaler) {
    res.status(400).json({
      success: false,
      error: "No Zscaler connection is configured for this organization.",
    });
    return;
  }

  let doc = await getZscalerSyncDocument(orgId);
  if (!doc || doc.taxonomy.length === 0) {
    doc = await syncOrgZscalerRules(orgId);
  }

  res.status(200).json({
    success: true,
    data: {
      categories: doc?.taxonomy ?? [],
      syncStatus: serializeSyncStatus(doc),
    },
  });
}

/** Explicit "Sync now" — bypasses the interval, still lock- and budget-guarded. */
export async function syncTeamZscalerController(
  req: RequestWithAuth,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;

  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;

  const orgConfig = await getOrgThreatProtectionConfig(orgId);
  if (!orgConfig?.zscaler) {
    res.status(400).json({
      success: false,
      error: "No Zscaler connection is configured for this organization.",
    });
    return;
  }

  const doc = await syncOrgZscalerRules(orgId);

  logger.info("Zscaler manual sync", {
    teamId: req.auth.team_id,
    orgId,
    status: doc?.status ?? "unknown",
  });

  res.status(200).json({
    success: true,
    data: { syncStatus: serializeSyncStatus(doc) },
  });
}
