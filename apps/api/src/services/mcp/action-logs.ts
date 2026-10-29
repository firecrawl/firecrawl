import { and, eq, sql } from "drizzle-orm";
import * as schema from "../../db/schema";
import { authCreditUsageChunkFromTeam } from "../../db/rpc";
import { clickhouseClient } from "../../lib/clickhouse-client";
import { logger } from "../../lib/logger";
import { logMcpActionLog } from "../logging/log_job";

const STATUSES = ["success", "error"] as const;
const AUTH_TYPES = ["oauth", "api-key"] as const;
const RESOURCES = new Set([
  "https://mcp.firecrawl.dev/v2/mcp",
  "https://mcp.firecrawl.dev/v2/mcp-oauth",
  "https://mcp.firecrawl.dev/v2/mcp-search",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const SECRET_PATTERN =
  /(?:\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:sk-|fc-|fco_|fcr_|fcmcp_)[A-Za-z0-9_-]+)/i;
const SECRET_PATTERN_ALL = new RegExp(SECRET_PATTERN.source, "gi");
const OBJECTIVE_MAX_LENGTH = 1000;
const ERROR_CODE_PATTERN = /^(?=.{2,64}$)[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MCP_CLIENT_SOURCES = ["client_info", "user_agent", "oauth"] as const;
const DURATION_MS_MAX = 2_147_483_647;
const INVALID_ARGUMENTS_MAX = 10;
const INVALID_ARGUMENT_PATTERN =
  /^(?:\(root\)|\*|[A-Za-z0-9_.-]{1,64}):[a-z_]{1,40}$/;
const RETENTION_DAYS = 30;
const ALLOWED_FIELDS = new Set([
  "team_id",
  "user_id",
  "api_key_id",
  "oauth_client_id",
  "auth_type",
  "tool_name",
  "status",
  "request_id",
  "user_agent",
  "client_name",
  "client_version",
  "error_class",
  "error_code",
  "resource",
  "objective",
  "api_job_id",
  "mcp_origin",
  "mcp_client",
  "mcp_client_source",
  "llm_model",
  "duration_ms",
  "invalid_arguments",
]);

export class McpActionLogValidationError extends Error {}
export class McpActionLogAuthorizationError extends Error {}
export class McpActionLogUnavailableError extends Error {}

function invalid(message: string): never {
  throw new McpActionLogValidationError(message);
}

function isCanonicalApiKeyId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d*$/.test(value) &&
    BigInt(value) <= POSTGRES_BIGINT_MAX
  );
}

function uuid(value: unknown, field: string, required = true): string | null {
  if (value == null || value === "") {
    if (required) invalid(`${field} is required`);
    return null;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid(`${field} must be a valid UUID`);
  }
  return value;
}

function text(value: unknown, field: string, max = 128, required = false) {
  if (value == null || value === "") {
    if (required) invalid(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") invalid(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized && required) invalid(`${field} is required`);
  if (normalized.length > max)
    invalid(`${field} must be at most ${max} characters`);
  if (/[\u0000-\u001F\u007F]/.test(normalized)) {
    invalid(`${field} must not contain control characters`);
  }
  if (SECRET_PATTERN.test(normalized)) {
    invalid(`${field} must not contain secret-like values`);
  }
  return normalized || null;
}

function errorCode(value: unknown) {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    !ERROR_CODE_PATTERN.test(value) ||
    SECRET_PATTERN.test(value)
  ) {
    invalid("error_code must be a lowercase snake_case code");
  }
  return value;
}

function objective(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "string") invalid("objective must be a string");
  const normalized = value
    .slice(0, OBJECTIVE_MAX_LENGTH * 4)
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(SECRET_PATTERN_ALL, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_.-]*$/, "[redacted]")
    .trim()
    .slice(0, OBJECTIVE_MAX_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trim();
  return normalized || null;
}

function durationMs(value: unknown) {
  if (value == null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > DURATION_MS_MAX
  ) {
    invalid("duration_ms must be a non-negative integer");
  }
  return value;
}

function invalidArguments(value: unknown) {
  if (value == null) return [];
  if (
    !Array.isArray(value) ||
    value.length > INVALID_ARGUMENTS_MAX ||
    !value.every(
      label =>
        typeof label === "string" && INVALID_ARGUMENT_PATTERN.test(label),
    )
  ) {
    invalid(
      `invalid_arguments must be at most ${INVALID_ARGUMENTS_MAX} <argument>:<issue> labels`,
    );
  }
  return value as string[];
}

type McpActionLogInput = {
  team_id: string;
  user_id: string | null;
  api_key_id: string | null;
  oauth_client_id: string | null;
  auth_type: (typeof AUTH_TYPES)[number];
  tool_name: string;
  status: (typeof STATUSES)[number];
  request_id: string;
  client_name: string | null;
  client_version: string | null;
  error_class: string | null;
  error_code: string | null;
  resource: string;
  objective: string | null;
  api_job_id: string | null;
  mcp_origin: string | null;
  mcp_client: string | null;
  mcp_client_source: (typeof MCP_CLIENT_SOURCES)[number] | null;
  llm_model: string | null;
  duration_ms: number | null;
  invalid_arguments: string[];
};

type McpActionLogRow = {
  id: string;
  user_id: string | null;
  api_key_id: string | null;
  oauth_client_id: string | null;
  auth_type: string;
  tool_name: string;
  status: string;
  request_id: string;
  client_name: string | null;
  client_version: string | null;
  error_class: string | null;
  resource: string;
  created_at: string;
};

export function normalizeMcpActionLogInput(
  payload: Record<string, unknown>,
): McpActionLogInput {
  for (const field of Object.keys(payload)) {
    if (!ALLOWED_FIELDS.has(field)) invalid(`${field} is not accepted`);
  }
  const authType = payload.auth_type;
  if (!AUTH_TYPES.includes(authType as (typeof AUTH_TYPES)[number])) {
    invalid("auth_type must be oauth or api-key");
  }
  const status = payload.status;
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
    invalid("status must be success or error");
  }
  const apiKeyId = payload.api_key_id;
  if (apiKeyId != null && !isCanonicalApiKeyId(apiKeyId)) {
    invalid("api_key_id must be a positive decimal string");
  }
  const userId = uuid(payload.user_id, "user_id", false);
  const oauthClientId = text(payload.oauth_client_id, "oauth_client_id");
  if (authType === "api-key") {
    if (apiKeyId == null) invalid("api_key_id is required for api-key events");
    if (userId || oauthClientId) {
      invalid("api-key events must not include OAuth identity fields");
    }
  } else {
    if (!userId) invalid("user_id is required for oauth events");
    if (!oauthClientId) invalid("oauth_client_id is required for oauth events");
  }
  const mcpClientSource = payload.mcp_client_source ?? null;
  if (
    mcpClientSource !== null &&
    !MCP_CLIENT_SOURCES.includes(
      mcpClientSource as (typeof MCP_CLIENT_SOURCES)[number],
    )
  ) {
    invalid("mcp_client_source must be client_info, user_agent or oauth");
  }
  const resource = text(payload.resource, "resource", 128, true)!;
  if (!RESOURCES.has(resource)) {
    invalid("resource must be a canonical hosted MCP URL");
  }
  return {
    team_id: uuid(payload.team_id, "team_id")!,
    user_id: userId,
    api_key_id: (apiKeyId as string | null | undefined) ?? null,
    oauth_client_id: oauthClientId,
    auth_type: authType as McpActionLogInput["auth_type"],
    tool_name: text(payload.tool_name, "tool_name", 128, true)!,
    status: status as McpActionLogInput["status"],
    request_id: uuid(payload.request_id, "request_id")!,
    client_name: text(payload.client_name, "client_name"),
    client_version: text(payload.client_version, "client_version"),
    error_class: text(payload.error_class, "error_class"),
    error_code: errorCode(payload.error_code),
    resource,
    objective: objective(payload.objective),
    api_job_id: text(payload.api_job_id, "api_job_id"),
    mcp_origin: text(payload.mcp_origin, "mcp_origin"),
    mcp_client: text(payload.mcp_client, "mcp_client"),
    mcp_client_source:
      mcpClientSource as McpActionLogInput["mcp_client_source"],
    llm_model: text(payload.llm_model, "llm_model"),
    duration_ms: durationMs(payload.duration_ms),
    invalid_arguments: invalidArguments(payload.invalid_arguments),
  };
}

async function exists(query: Promise<unknown[]>) {
  return (await query).length > 0;
}

export async function validateMcpActionLogActor(
  db: any,
  input: McpActionLogInput,
) {
  if (input.auth_type === "api-key" || input.api_key_id != null) {
    const found = await exists(
      db
        .select({ id: schema.api_keys.id })
        .from(schema.api_keys)
        .where(
          and(
            sql`${schema.api_keys.id} = cast(${input.api_key_id!} as bigint)`,
            eq(schema.api_keys.team_id, input.team_id),
          ),
        )
        .limit(1),
    );
    if (!found) {
      throw new McpActionLogAuthorizationError(
        "api_key_id does not belong to team_id",
      );
    }
  }
  if (input.auth_type === "oauth") {
    const found = await exists(
      db
        .select({ user_id: schema.user_teams.user_id })
        .from(schema.user_teams)
        .where(
          and(
            eq(schema.user_teams.user_id, input.user_id!),
            eq(schema.user_teams.team_id, input.team_id),
          ),
        )
        .limit(1),
    );
    if (!found) {
      throw new McpActionLogAuthorizationError(
        "user_id does not belong to team_id",
      );
    }
  }
}

export async function resolveMcpActionLogTeamPolicy(db: any, teamId: string) {
  const rows = await authCreditUsageChunkFromTeam(db, teamId);
  if (rows.length === 0 || rows[0].team_id === null) return null;
  return { flags: rows[0].flags ?? null };
}

export async function recordMcpActionLog(input: McpActionLogInput) {
  await logMcpActionLog({ id: input.request_id, ...input });
  return { disposition: "accepted" as const, id: input.request_id };
}

export async function authorizeMcpActionLogViewer(
  db: any,
  teamId: string,
  apiKeyId: string | number | null | undefined,
) {
  const canonicalApiKeyId =
    typeof apiKeyId === "string"
      ? isCanonicalApiKeyId(apiKeyId)
        ? apiKeyId
        : null
      : typeof apiKeyId === "number" &&
          Number.isSafeInteger(apiKeyId) &&
          apiKeyId > 0
        ? String(apiKeyId)
        : null;
  if (!canonicalApiKeyId) {
    throw new McpActionLogAuthorizationError(
      "An owner-bound API key is required",
    );
  }
  const keyRows = await db
    .select({ owner_id: schema.api_keys.owner_id })
    .from(schema.api_keys)
    .where(
      and(
        sql`${schema.api_keys.id} = cast(${canonicalApiKeyId} as bigint)`,
        eq(schema.api_keys.team_id, teamId),
      ),
    )
    .limit(1);
  const ownerId = keyRows[0]?.owner_id;
  if (!ownerId) {
    throw new McpActionLogAuthorizationError(
      "An owner-bound API key is required",
    );
  }
  const membershipRows = await db
    .select({ role: schema.user_teams.role })
    .from(schema.user_teams)
    .where(
      and(
        eq(schema.user_teams.user_id, ownerId),
        eq(schema.user_teams.team_id, teamId),
      ),
    )
    .limit(1);
  const role = membershipRows[0]?.role;
  if (role !== "admin" && role !== "owner") {
    throw new McpActionLogAuthorizationError("Team admin access is required");
  }
  return { userId: ownerId, role };
}

function encodeMcpActionLogCursor(row: { created_at: string; id: string }) {
  return Buffer.from(
    JSON.stringify({ created_at: row.created_at, id: row.id }),
  ).toString("base64url");
}

export function decodeMcpActionLogCursor(cursor: string) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value.created_at !== "string" ||
      Number.isNaN(Date.parse(value.created_at)) ||
      typeof value.id !== "string" ||
      !UUID_PATTERN.test(value.id)
    ) {
      invalid("cursor is invalid");
    }
    return value as { created_at: string; id: string };
  } catch (error) {
    if (error instanceof McpActionLogValidationError) throw error;
    invalid("cursor is invalid");
  }
}

export async function listMcpActionLogs(
  teamId: string,
  options: { limit?: number; cursor?: string | null } = {},
) {
  if (!clickhouseClient) {
    throw new McpActionLogUnavailableError(
      "MCP action log storage is unavailable",
    );
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursor = options.cursor
    ? decodeMcpActionLogCursor(options.cursor)
    : null;
  let rows: McpActionLogRow[];
  try {
    const result = await clickhouseClient.query({
      // The explicit column list is the team-readable contract: objective and
      // api_job_id stay out of it. Filters name `log.` columns because the
      // formatted created_at alias would otherwise shadow the stored value.
      query: `SELECT id, user_id, toString(log.api_key_id) AS api_key_id, oauth_client_id, auth_type, tool_name, status, request_id, client_name, client_version, error_class, resource, formatDateTime(log.created_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS created_at FROM mcp_action_logs AS log FINAL WHERE log.team_id = {teamId: UUID} AND log.created_at > now64(9) - INTERVAL ${RETENTION_DAYS} DAY${cursor ? " AND (log.created_at, log.id) < (parseDateTime64BestEffort({before: String}, 9), {beforeId: UUID})" : ""} ORDER BY log.created_at DESC, log.id DESC LIMIT {limit: UInt32}`,
      query_params: {
        teamId,
        limit: limit + 1,
        ...(cursor ? { before: cursor.created_at, beforeId: cursor.id } : {}),
      },
      format: "JSONEachRow",
    });
    rows = await result.json<McpActionLogRow>();
  } catch (error) {
    logger.warn("Failed to read MCP action logs", { error });
    throw new McpActionLogUnavailableError(
      "MCP action log storage is unavailable",
    );
  }
  return {
    data: rows.slice(0, limit),
    nextCursor:
      rows.length > limit ? encodeMcpActionLogCursor(rows[limit - 1]) : null,
  };
}
