import { Request, Response } from "express";
import { config } from "../../config";
import { db, dbRr } from "../../db/connection";
import { ErrorResponse, RequestWithAuth, TeamFlags } from "./types";
import {
  authorizeMcpActionLogViewer,
  listMcpActionLogs,
  McpActionLogAuthorizationError,
  McpActionLogValidationError,
  normalizeMcpActionLogInput,
  purgeMcpActionLogsForTeam,
  recordMcpActionLog,
  resolveMcpActionLogTeamPolicy,
  validateMcpActionLogActor,
} from "../../services/mcp/action-logs";

type InternalRequest = Request<unknown, unknown, Record<string, unknown>>;
type ListResponse =
  | { success: true; data: unknown[]; nextCursor: string | null }
  | ErrorResponse;

function isMcpActionLogZdrTeam(flags: TeamFlags | undefined) {
  return (
    flags?.forceZDR === true ||
    flags?.scrapeZDR === "forced" ||
    flags?.searchZDR === "forced" ||
    flags?.searchZDR === "forced-zdr" ||
    flags?.searchZDR === "forced-anon"
  );
}

export async function ingestMcpActionLogController(
  req: InternalRequest,
  res: Response,
) {
  try {
    const input = normalizeMcpActionLogInput(req.body ?? {});
    await validateMcpActionLogActor(db, input);
    const team = await resolveMcpActionLogTeamPolicy(db, input.team_id);
    if (!team) {
      return res.status(503).json({
        success: false,
        error: "Team policy could not be resolved",
      });
    }
    if (isMcpActionLogZdrTeam(team.flags)) {
      await purgeMcpActionLogsForTeam(db, input.team_id);
      return res.status(202).json({
        success: true,
        disposition: "zero-data-retention",
        id: null,
      });
    }
    const result = await recordMcpActionLog(db, input);
    return res.status(202).json({ success: true, ...result });
  } catch (error) {
    if (error instanceof McpActionLogValidationError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (error instanceof McpActionLogAuthorizationError) {
      return res.status(403).json({ success: false, error: error.message });
    }
    return res.status(500).json({
      success: false,
      error: "Failed to persist MCP action log",
    });
  }
}

export async function listMcpActionLogsController(
  req: RequestWithAuth,
  res: Response<ListResponse>,
) {
  try {
    if (!config.MCP_ACTION_LOG_STORAGE_ENABLED) {
      return res.status(503).json({
        success: false,
        error: "MCP action logging is disabled",
      });
    }
    await authorizeMcpActionLogViewer(
      db,
      req.auth.team_id,
      req.acuc?.api_key_id_text ?? req.acuc?.api_key_id,
    );
    const team = await resolveMcpActionLogTeamPolicy(db, req.auth.team_id);
    if (!team) {
      return res.status(503).json({
        success: false,
        error: "Team policy could not be resolved",
      });
    }
    if (isMcpActionLogZdrTeam(team.flags)) {
      await purgeMcpActionLogsForTeam(db, req.auth.team_id);
      return res.status(200).json({
        success: true,
        data: [],
        nextCursor: null,
      });
    }
    const parsedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const result = await listMcpActionLogs(dbRr, req.auth.team_id, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    if (error instanceof McpActionLogAuthorizationError) {
      return res.status(403).json({ success: false, error: error.message });
    }
    if (error instanceof McpActionLogValidationError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    throw error;
  }
}
