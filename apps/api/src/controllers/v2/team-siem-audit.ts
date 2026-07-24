import { randomUUID } from "crypto";
import type { Response } from "express";
import type { RequestWithAuth } from "./types";
import { logger as _logger } from "../../lib/logger";
import { sendAzureSentinelEvents } from "../../lib/siem-audit/azure-sentinel";
import {
  getOrgSiemAuditConfig,
  upsertOrgSiemAuditConfig,
} from "../../lib/siem-audit/store";
import {
  SiemDeliveryError,
  siemAuditConfigInputSchema,
  type OrgSiemAuditConfig,
  type ScrapeActivityEvent,
} from "../../lib/siem-audit/types";
import { getOrgIdForTeam } from "../../lib/threat-protection/store";

const logger = _logger.child({ module: "team-siem-audit" });
const SUPPORT_EMAIL = "support@firecrawl.com";

function rejectWithoutFlag(
  req: RequestWithAuth<any, any, any>,
  res: Response,
): boolean {
  if (req.acuc?.flags?.siemAudit !== true) {
    res.status(403).json({
      success: false,
      error: `SIEM audit streaming is an enterprise feature and is not enabled for your team. Contact ${SUPPORT_EMAIL} to explore whether it can be enabled for your team.`,
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
  if (orgId) return orgId;
  logger.error("Failed to resolve org for SIEM configuration", {
    teamId: req.auth.team_id,
  });
  res.status(500).json({
    success: false,
    error: "Failed to resolve the organization for this team.",
  });
  return null;
}

function serializeConfig(config: OrgSiemAuditConfig | null) {
  if (!config) return { configured: false, enabled: false, destination: null };
  const { clientSecret: _clientSecret, ...destination } = config.destination;
  return {
    configured: true,
    enabled: config.enabled,
    destination: {
      ...destination,
      clientSecretConfigured: true,
    },
    updatedAt: config.updatedAt,
  };
}

export async function getTeamSiemAuditController(
  req: RequestWithAuth,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;
  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;
  const config = await getOrgSiemAuditConfig(orgId);
  res.status(200).json({ success: true, data: serializeConfig(config) });
}

export async function putTeamSiemAuditController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;
  const input = siemAuditConfigInputSchema.parse(req.body);
  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;

  try {
    const updated = await upsertOrgSiemAuditConfig(orgId, input);
    logger.info("SIEM audit configuration updated", {
      teamId: req.auth.team_id,
      orgId,
      enabled: updated.enabled,
      destinationType: updated.destination.type,
      streamName: updated.destination.streamName,
    });
    res.status(200).json({
      success: true,
      data: serializeConfig(updated),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "clientSecret is required when SIEM is first configured"
    ) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    throw error;
  }
}

export async function testTeamSiemAuditController(
  req: RequestWithAuth,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;
  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;
  const siemConfig = await getOrgSiemAuditConfig(orgId);
  if (!siemConfig?.enabled) {
    res.status(409).json({
      success: false,
      error: "SIEM audit streaming is not configured and enabled.",
    });
    return;
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const event: ScrapeActivityEvent = {
    schema_version: 1,
    event_type: "scrape_activity",
    scrape_id: id,
    request_id: id,
    endpoint: "scrape",
    team_id: req.auth.team_id,
    org_id: orgId,
    api_key: {
      id:
        req.acuc?.api_key_id_text ??
        (req.acuc?.api_key_id == null ? null : String(req.acuc.api_key_id)),
      name: null,
    },
    audit_metadata: { synthetic: "true" },
    started_at: now,
    completed_at: now,
    url: "https://example.com/siem-test",
    domain: "example.com",
    http_method: "GET",
    http_status: 200,
    result: "success",
    error: null,
    origin: "siem-test",
    integration: null,
    zero_data_retention: true,
  };

  try {
    await sendAzureSentinelEvents(siemConfig.destination, [event]);
    res.status(200).json({ success: true, data: { delivered: true } });
  } catch (error) {
    if (error instanceof SiemDeliveryError) {
      const status =
        error.kind === "invalid_credentials" ||
        error.kind === "schema_rejection"
          ? 400
          : 502;
      res.status(status).json({
        success: false,
        error: {
          type: error.kind,
          message: error.message,
          statusCode: error.statusCode ?? null,
        },
      });
      return;
    }
    throw error;
  }
}
