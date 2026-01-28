import { createClient, ClickHouseClient } from "@clickhouse/client";
import { config } from "../config";
import { logger } from "../lib/logger";

let activityLogsClickhouse: ClickHouseClient | null = null;

export function getActivityLogsClickhouse(): ClickHouseClient {
  if (activityLogsClickhouse) {
    return activityLogsClickhouse;
  }

  if (!config.CLICKHOUSE_URL) {
    throw new Error("CLICKHOUSE_URL is not configured");
  }

  activityLogsClickhouse = createClient({
    url: config.CLICKHOUSE_URL,
    username: config.CLICKHOUSE_USERNAME,
    password: config.CLICKHOUSE_PASSWORD,
    database: config.CLICKHOUSE_DATABASE,
  });

  logger.info("Initialized ClickHouse client for activity logs", {
    module: "clickhouse",
  });

  return activityLogsClickhouse;
}

export function isClickhouseConfigured(): boolean {
  return !!config.CLICKHOUSE_URL;
}
