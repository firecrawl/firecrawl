import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { RequestWithAuth } from "./types";
import { getThreatProtection } from "../../lib/zdr-helpers";
import { threatProtectionConfigSchema } from "../../lib/threat-protection/config";
import {
  InvalidThreatLogsCursorError,
  queryThreatProtectionLogs,
} from "../../lib/threat-protection/logs";
import {
  getOrgIdForTeam,
  getOrgThreatProtectionConfig,
  resolveEffectivePolicy,
  upsertOrgThreatProtectionConfig,
  type OrgThreatProtectionConfig,
} from "../../lib/threat-protection/store";
import { sendSiemTestEvent } from "../../services/webhook/siem";

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
 * Effective config document served by GET and PUT. Always includes every
 * policy field (defaults applied), so the dashboard can render the form
 * without knowing the defaults. The SIEM secret is never echoed back.
 */
function serializeConfig(orgConfig: OrgThreatProtectionConfig | null) {
  const policy = resolveEffectivePolicy(orgConfig);
  return {
    ...policy,
    allowRequestOverrides: orgConfig?.allowRequestOverrides ?? true,
    siem: orgConfig?.siem
      ? {
          url: orgConfig.siem.url,
          events: orgConfig.siem.events,
          secretSet: orgConfig.siem.secret !== null,
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

  res.status(200).json({
    success: true,
    data: serializeConfig(orgConfig),
  });
}

export async function putTeamThreatProtectionController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;

  const input = threatProtectionConfigSchema.parse(req.body);

  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;

  const previous = await getOrgThreatProtectionConfig(orgId);
  const updated = await upsertOrgThreatProtectionConfig(orgId, input);

  // Audit log — org-level security configuration change.
  logger.info("Threat protection config updated", {
    teamId: req.auth.team_id,
    orgId,
    mode: updated.policy.mode,
    changedFields: changedFields(previous, updated),
  });

  res.status(200).json({
    success: true,
    data: serializeConfig(updated),
  });
}

// =========================================
// Security log export (ENG-4987 pull)
// =========================================

const threatProtectionLogsQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  decision: z.enum(["allowed", "blocked"]).optional(),
  domain: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

/**
 * GET /v2/team/threat-protection/logs — pull export of the org's threat
 * protection security log (ClickHouse-backed), newest-first,
 * cursor-paginated. Query params: from, to (ISO timestamps), decision
 * (allowed|blocked), domain, cursor, limit (default 100, max 1000).
 */
export async function getTeamThreatProtectionLogsController(
  req: RequestWithAuth,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;

  const query = threatProtectionLogsQuerySchema.parse(req.query);
  if (query.from && query.to && query.from > query.to) {
    res.status(400).json({
      success: false,
      error: '"from" must not be after "to".',
    });
    return;
  }

  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;

  let page;
  try {
    page = await queryThreatProtectionLogs({
      orgId,
      from: query.from,
      to: query.to,
      decision: query.decision,
      domain: query.domain,
      cursor: query.cursor,
      limit: query.limit,
    });
  } catch (error) {
    if (error instanceof InvalidThreatLogsCursorError) {
      res.status(400).json({ success: false, error: "Invalid cursor." });
      return;
    }
    throw error;
  }

  if (page === null) {
    // No analytics ClickHouse configured (e.g. self-hosted).
    res.status(200).json({
      success: true,
      data: { logs: [], nextCursor: null },
      warning: "Security log storage is not configured on this instance.",
    });
    return;
  }

  res.status(200).json({
    success: true,
    data: page,
  });
}

// =========================================
// SIEM test event (ENG-4987 push)
// =========================================

/**
 * POST /v2/team/threat-protection/test-siem — sends one synthetic,
 * clearly-marked test event to the org's configured SIEM destination and
 * reports the delivery outcome.
 */
export async function postTeamThreatProtectionTestSiemController(
  req: RequestWithAuth,
  res: Response,
): Promise<void> {
  if (rejectWithoutFlag(req, res)) return;

  const orgId = await resolveOrgId(req, res);
  if (!orgId) return;

  const orgConfig = await getOrgThreatProtectionConfig(orgId);
  if (!orgConfig?.siem?.url) {
    res.status(400).json({
      success: false,
      error:
        "No SIEM destination is configured. Set siem.url via PUT /v2/team/threat-protection first.",
    });
    return;
  }

  const result = await sendSiemTestEvent(
    orgId,
    req.auth.team_id,
    orgConfig.siem,
  );

  logger.info("SIEM test event sent", {
    teamId: req.auth.team_id,
    orgId,
    delivered: result.delivered,
    statusCode: result.statusCode,
  });

  res.status(200).json({
    success: true,
    data: result,
  });
}
