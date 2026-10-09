import { clickhouseClient } from "../../lib/clickhouse-client";

/** Tests that read the job log skip unless CLICKHOUSE_ANALYTICS_URL is set. */
export const HAS_JOB_LOG = clickhouseClient !== null;

// The job log lives in ClickHouse, fed by ClickPipes a few seconds behind the
// publish. Tables are ReplacingMergeTree ordered by (team_id, id); FINAL keeps
// the latest publication of an id and the day bound prunes partitions.
export async function jobLogRows<T extends Record<string, unknown>>(
  table: string,
  where: string,
  params: Record<string, string | number>,
  options: { orderBy?: string; limit?: number } = {},
): Promise<T[]> {
  if (clickhouseClient === null) {
    throw new Error("CLICKHOUSE_ANALYTICS_URL is required to read the job log");
  }
  const result = await clickhouseClient.query({
    query: `SELECT * FROM ${table} FINAL WHERE ${where} AND created_at >= now() - INTERVAL 1 DAY${
      options.orderBy ? ` ORDER BY ${options.orderBy}` : ""
    }${options.limit ? ` LIMIT ${options.limit}` : ""}`,
    query_params: params,
    format: "JSONEachRow",
  });
  return result.json<T>();
}

/** Polls until at least `min` rows match; returns the last read, which may be short. */
export async function waitForJobLogRows<T extends Record<string, unknown>>(
  table: string,
  where: string,
  params: Record<string, string | number>,
  options: { orderBy?: string; limit?: number; min?: number } = {},
  timeoutMs = 30000,
): Promise<T[]> {
  const { min = 1, ...query } = options;
  const deadline = Date.now() + timeoutMs;
  let rows = await jobLogRows<T>(table, where, params, query);
  while (rows.length < min && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    rows = await jobLogRows<T>(table, where, params, query);
  }
  return rows;
}

/** Polls for the newest matching row; null when none lands in time. */
export async function waitForJobLogRow<T extends Record<string, unknown>>(
  table: string,
  where: string,
  params: Record<string, string | number>,
  timeoutMs = 30000,
): Promise<T | null> {
  const [row] = await waitForJobLogRows<T>(
    table,
    where,
    params,
    { orderBy: "created_at DESC", limit: 1 },
    timeoutMs,
  );
  return row ?? null;
}

/** Parses a job log JSON column; empty or malformed text reads as null. */
export function jobLogJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
