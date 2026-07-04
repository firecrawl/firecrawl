import { createClient } from "@clickhouse/client";
import { config } from "../config";
import { logger } from "./logger";

const client = config.CLICKHOUSE_ANALYTICS_URL
  ? createClient({
      url: config.CLICKHOUSE_ANALYTICS_URL,
      database: config.CLICKHOUSE_ANALYTICS_DATABASE ?? "default",
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 0,
      },
    })
  : null;

/**
 * Runs a parameterized SELECT against the analytics ClickHouse and returns
 * the rows, or `null` when ClickHouse is not configured on this instance.
 * Errors propagate to the caller.
 */
export async function chQuery<T extends Record<string, unknown>>(
  query: string,
  params?: Record<string, unknown>,
): Promise<T[] | null> {
  if (!client) return null;

  const resultSet = await client.query({
    query,
    query_params: params,
    format: "JSONEachRow",
  });
  return await resultSet.json<T>();
}

export async function chInsert(
  table: string,
  rows: Record<string, unknown>[],
  opts?: { throwOnError?: boolean },
): Promise<boolean> {
  if (rows.length === 0) return true;
  if (!client) return false;

  try {
    await client.insert({
      table,
      values: rows,
      format: "JSONEachRow",
    });
    return true;
  } catch (error: any) {
    logger.error("ClickHouse insert failed", {
      table,
      rowCount: rows.length,
      error: error?.message,
    });
    if (opts?.throwOnError) {
      throw error;
    }
    return false;
  }
}
