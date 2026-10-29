type McpActionLogConfigInput = {
  MCP_ACTION_LOG_STORAGE_ENABLED?: boolean;
  MCP_ACTION_LOG_WRITES_ENABLED?: boolean;
  MCP_ACTION_LOG_SECRET?: string;
  PUBSUB_CREDENTIALS?: string;
  USE_DB_AUTHENTICATION?: boolean;
};

export function getMcpActionLogConfigErrors(config: McpActionLogConfigInput) {
  const errors: Array<{
    path: keyof McpActionLogConfigInput;
    message: string;
  }> = [];
  if (
    config.MCP_ACTION_LOG_STORAGE_ENABLED === true &&
    config.USE_DB_AUTHENTICATION !== true
  ) {
    errors.push({
      path: "MCP_ACTION_LOG_STORAGE_ENABLED",
      message: "MCP action log storage requires USE_DB_AUTHENTICATION=true",
    });
  }
  if (
    config.MCP_ACTION_LOG_WRITES_ENABLED === true &&
    config.MCP_ACTION_LOG_STORAGE_ENABLED !== true
  ) {
    errors.push({
      path: "MCP_ACTION_LOG_WRITES_ENABLED",
      message:
        "MCP action log writes require MCP_ACTION_LOG_STORAGE_ENABLED=true",
    });
  }
  if (
    config.MCP_ACTION_LOG_WRITES_ENABLED === true &&
    !config.MCP_ACTION_LOG_SECRET?.trim()
  ) {
    errors.push({
      path: "MCP_ACTION_LOG_SECRET",
      message:
        "MCP action log writes require a non-empty MCP_ACTION_LOG_SECRET",
    });
  }
  if (
    config.MCP_ACTION_LOG_WRITES_ENABLED === true &&
    !config.PUBSUB_CREDENTIALS?.trim()
  ) {
    errors.push({
      path: "PUBSUB_CREDENTIALS",
      message: "MCP action log writes require the job-log publisher",
    });
  }
  return errors;
}
