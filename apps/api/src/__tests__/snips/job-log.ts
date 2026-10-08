import { clickhouseClient } from "../../lib/clickhouse-client";

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

/** Polls for the first matching row; null when none lands in time. */
export async function waitForJobLogRow<T extends Record<string, unknown>>(
  table: string,
  where: string,
  params: Record<string, string | number>,
  timeoutMs = 30000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await jobLogRows<T>(table, where, params, {
      orderBy: "created_at DESC",
      limit: 1,
    });
    if (row) return row;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return null;
}

/** JSON columns are stored as strings in the job log. */
export function jobLogJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : (value ?? null);
}
