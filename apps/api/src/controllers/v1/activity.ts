import { Response } from "express";
import { and, desc, eq, gte, lt, or } from "drizzle-orm";
import { RequestWithAuth, ErrorResponse } from "./types";
import { dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
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

const VALID_ENDPOINTS = [
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

  // Build query
  const windowStart = new Date(
    Date.now() - ACTIVITY_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const conditions = [
    eq(schema.requests.team_id, req.auth.team_id),
    gte(schema.requests.created_at, windowStart),
  ];

  if (endpoint) {
    conditions.push(eq(schema.requests.kind, endpoint));
  }

  if (cursor) {
    // For keyset pagination: fetch rows where (created_at, id) < (cursor.createdAt, cursor.id)
    // This translates to: created_at < cursor OR (created_at = cursor AND id < cursor.id)
    conditions.push(
      or(
        lt(schema.requests.created_at, cursor.createdAt),
        and(
          eq(schema.requests.created_at, cursor.createdAt),
          lt(schema.requests.id, cursor.id),
        ),
      )!,
    );
  }

  let data: {
    id: string;
    kind: string | null;
    api_version: string | null;
    created_at: string | null;
    target_hint: string | null;
  }[];
  try {
    data = await dbRr
      .select({
        id: schema.requests.id,
        kind: schema.requests.kind,
        api_version: schema.requests.api_version,
        created_at: schema.requests.created_at,
        target_hint: schema.requests.target_hint,
      })
      .from(schema.requests)
      .where(and(...conditions))
      .orderBy(desc(schema.requests.created_at), desc(schema.requests.id))
      .limit(limit + 1); // fetch one extra to determine has_more
  } catch (error) {
    logger.error("Failed to fetch activity", { error });
    return res.status(500).json({
      success: false,
      error: "Failed to fetch activity.",
    });
  }

  const hasMore = (data?.length ?? 0) > limit;
  const items = hasMore ? data!.slice(0, limit) : (data ?? []);

  const responseData: ActivityItem[] = items.map((row: any) => ({
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
