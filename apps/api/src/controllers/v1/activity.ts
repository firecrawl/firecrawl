import { Response } from "express";
import { RequestWithAuth, ErrorResponse } from "./types";
import { clickhouseClient } from "../../lib/clickhouse-client";
import { logger as _logger } from "../../lib/logger";

const ACTIVITY_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}:${id}`).toString("base64url");
}

function decodeCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString();
    const sepIdx = decoded.lastIndexOf(":");
    if (sepIdx === -1) return null;
    const createdAt = decoded.slice(0, sepIdx);
    const id = decoded.slice(sepIdx + 1);
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function toClickHouseDateTime(value: string): string {
  return value.replace("T", " ").replace(/Z$/, "");
}

const VALID_ENDPOINTS = [
  "alexandria",
  "scrape",
  "crawl",
  "batch_scrape",
  "search",
  "extract",
  "llmstxt",
  "deep_research",
  "map",
  "agent",
  "browser",
  "interact",
] as const;

type ActivityEndpoint = (typeof VALID_ENDPOINTS)[number];

interface ActivityItem {
  id: string;
  endpoint: ActivityEndpoint;
  api_version: string;
  created_at: string;
  target: string | null;
}

interface ActivityResponse {
  success: true;
  data: ActivityItem[];
  cursor: string | null;
  has_more: boolean;
}

interface ActivityRow {
  id: string;
  kind: ActivityEndpoint;
  api_version: string;
  created_at: string;
  target_hint: string | null;
}

export async function activityController(
  req: RequestWithAuth,
  res: Response<ActivityResponse | ErrorResponse>,
) {
  const logger = _logger.child({
    module: "activity",
    method: "activityController",
    teamId: req.auth.team_id,
  });

  // Parse and validate query params
  const endpoint = req.query.endpoint as string | undefined;
  if (endpoint && !VALID_ENDPOINTS.includes(endpoint as ActivityEndpoint)) {
    return res.status(400).json({
      success: false,
      error: `Invalid endpoint filter. Must be one of: ${VALID_ENDPOINTS.join(", ")}`,
    });
  }

  let limit = parseInt(req.query.limit as string, 10);
  if (isNaN(limit) || limit < 1) {
    limit = DEFAULT_LIMIT;
  }
  limit = Math.min(limit, MAX_LIMIT);

  const rawCursor = req.query.cursor as string | undefined;
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;

  if (rawCursor && !cursor) {
    return res.status(400).json({
      success: false,
      error: "Invalid cursor.",
    });
  }

  if (clickhouseClient === null) {
    return res.status(501).json({
      success: false,
      error: "This endpoint is only available if ClickHouse is configured.",
    });
  }

  const windowStart = toClickHouseDateTime(
    new Date(Date.now() - ACTIVITY_WINDOW_HOURS * 60 * 60 * 1000).toISOString(),
  );

  const conditions = [
    "team_id = {teamId: UUID}",
    "created_at >= {windowStart: DateTime64(3)}",
  ];
  const queryParams: Record<string, string | number> = {
    teamId: req.auth.team_id,
    windowStart,
    limit: limit + 1,
  };

  if (endpoint === "alexandria") {
    conditions.push(
      "(kind = 'alexandria' OR (kind = 'scrape' AND startsWith(target_hint, 'alexandria:')))",
    );
  } else if (endpoint) {
    conditions.push("kind = {endpoint: String}");
    queryParams.endpoint = endpoint;
  }

  if (cursor) {
    conditions.push(
      "(created_at < {cursorCreatedAt: DateTime64(3)} OR (created_at = {cursorCreatedAt: DateTime64(3)} AND id < {cursorId: UUID}))",
    );
    queryParams.cursorCreatedAt = toClickHouseDateTime(cursor.createdAt);
    queryParams.cursorId = cursor.id;
  }

  let data: ActivityRow[];
  try {
    const result = await clickhouseClient.query({
      query: `
        SELECT id, kind, api_version, created_at, target_hint
        FROM requests
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT 1 BY id
        LIMIT {limit: UInt32}
      `,
      query_params: queryParams,
      format: "JSONEachRow",
    });
    data = await result.json<ActivityRow>();
  } catch (error) {
    logger.error("Failed to fetch activity", { error });
    return res.status(500).json({
      success: false,
      error: "Failed to fetch activity.",
    });
  }

  const hasMore = data.length > limit;
  const items = hasMore ? data.slice(0, limit) : data;

  const responseData: ActivityItem[] = items.map(row => ({
    id: row.id,
    endpoint: row.kind,
    api_version: row.api_version,
    created_at: row.created_at,
    target: row.target_hint,
  }));

  const lastItem =
    hasMore && responseData.length > 0
      ? responseData[responseData.length - 1]
      : null;
  const nextCursor = lastItem
    ? encodeCursor(lastItem.created_at, lastItem.id)
    : null;

  return res.status(200).json({
    success: true,
    data: responseData,
    cursor: nextCursor,
    has_more: hasMore,
  });
}
