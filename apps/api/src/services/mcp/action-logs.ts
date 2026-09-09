import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import * as schema from "../../db/schema";
import { authCreditUsageChunkFromTeam } from "../../db/rpc";
import { logger } from "../../lib/logger";

const STATUSES = ["success", "error"] as const;
const AUTH_TYPES = ["oauth", "api-key"] as const;
const RESOURCES = new Set([
  "https://mcp.firecrawl.dev/v2/mcp",
  "https://mcp.firecrawl.dev/v2/mcp-oauth",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const SECRET_PATTERN =
  /(?:\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:sk-|fc-|fco_|fcr_|fcmcp_)[A-Za-z0-9_-]+)/i;
const RETENTION_DAYS = 30;
const CLEANUP_BATCH_SIZE = 500;
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
  "resource",
]);

export class McpActionLogValidationError extends Error {}
export class McpActionLogAuthorizationError extends Error {}

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
  resource: string;
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
    resource,
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

async function cleanupExpiredMcpActionLogs(db: any) {
  await db.execute(sql`
    with expired as (
      select id from mcp_action_logs
      where expires_at <= now()
      order by expires_at asc
      limit ${CLEANUP_BATCH_SIZE}
    )
    delete from mcp_action_logs
    where id in (select id from expired)
  `);
}

export async function purgeMcpActionLogsForTeam(db: any, teamId: string) {
  await db
    .delete(schema.mcp_action_logs)
    .where(eq(schema.mcp_action_logs.team_id, teamId));
}

type RetentionTimer = {
  unref?: () => void;
};

export function startMcpActionLogRetentionWorker(options: {
  db: any;
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, intervalMs: number) => RetentionTimer;
  clearIntervalFn?: (timer: RetentionTimer) => void;
}) {
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
  const setIntervalFn =
    options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn =
    options.clearIntervalFn ??
    (timer => clearInterval(timer as NodeJS.Timeout));
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupExpiredMcpActionLogs(options.db);
    } catch (error) {
      logger.warn("Failed to clean up expired MCP action logs", { error });
    } finally {
      running = false;
    }
  };

  const timer = setIntervalFn(() => void run(), intervalMs);
  timer.unref?.();
  const ready = run();

  return {
    ready,
    run,
    stop: () => clearIntervalFn(timer),
  };
}

export function startMcpActionLogRetentionWorkerIfEnabled(options: {
  enabled: boolean;
  db: any;
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, intervalMs: number) => RetentionTimer;
  clearIntervalFn?: (timer: RetentionTimer) => void;
}) {
  if (!options.enabled) return null;
  return startMcpActionLogRetentionWorker(options);
}

export async function recordMcpActionLog(db: any, input: McpActionLogInput) {
  const expiresAt = new Date(
    Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const rows = await db
    .insert(schema.mcp_action_logs)
    .values({
      ...input,
      api_key_id:
        input.api_key_id === null
          ? null
          : sql`cast(${input.api_key_id} as bigint)`,
      expires_at: expiresAt,
    })
    .onConflictDoNothing({
      target: [
        schema.mcp_action_logs.team_id,
        schema.mcp_action_logs.request_id,
      ],
    })
    .returning({ id: schema.mcp_action_logs.id });
  return rows[0]
    ? { disposition: "stored" as const, id: rows[0].id }
    : { disposition: "duplicate" as const, id: null };
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

export function encodeMcpActionLogCursor(row: {
  created_at: Date | string;
  id: string;
}) {
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at;
  return Buffer.from(
    JSON.stringify({ created_at: createdAt, id: row.id }),
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
  db: any,
  teamId: string,
  options: { limit?: number; cursor?: string | null } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursor = options.cursor
    ? decodeMcpActionLogCursor(options.cursor)
    : null;
  const cursorClause = cursor
    ? or(
        lt(schema.mcp_action_logs.created_at, cursor.created_at),
        and(
          eq(schema.mcp_action_logs.created_at, cursor.created_at),
          lt(schema.mcp_action_logs.id, cursor.id),
        ),
      )
    : undefined;
  const rows = await db
    .select({
      id: schema.mcp_action_logs.id,
      user_id: schema.mcp_action_logs.user_id,
      // API-key identifiers are bigint in Postgres. Read them as text so the
      // JSON boundary never rounds values beyond JavaScript's safe integer range.
      api_key_id: sql<
        string | null
      >`${schema.mcp_action_logs.api_key_id}::text`,
      oauth_client_id: schema.mcp_action_logs.oauth_client_id,
      auth_type: schema.mcp_action_logs.auth_type,
      tool_name: schema.mcp_action_logs.tool_name,
      status: schema.mcp_action_logs.status,
      request_id: schema.mcp_action_logs.request_id,
      client_name: schema.mcp_action_logs.client_name,
      client_version: schema.mcp_action_logs.client_version,
      error_class: schema.mcp_action_logs.error_class,
      resource: schema.mcp_action_logs.resource,
      created_at: schema.mcp_action_logs.created_at,
    })
    .from(schema.mcp_action_logs)
    .where(
      and(
        eq(schema.mcp_action_logs.team_id, teamId),
        gt(schema.mcp_action_logs.expires_at, new Date().toISOString()),
        cursorClause,
      ),
    )
    .orderBy(
      desc(schema.mcp_action_logs.created_at),
      desc(schema.mcp_action_logs.id),
    )
    .limit(limit + 1);
  return {
    data: rows.slice(0, limit),
    nextCursor:
      rows.length > limit ? encodeMcpActionLogCursor(rows[limit - 1]) : null,
  };
}
