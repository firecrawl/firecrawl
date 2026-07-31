import { describe, expect, it } from "vitest";
import { getMcpActionLogConfigErrors } from "./mcp-action-log-config";

describe("MCP action log configuration", () => {
  it("is inert by default", () => {
    expect(getMcpActionLogConfigErrors({})).toEqual([]);
  });

  it("requires primary database authentication before enabling storage", () => {
    expect(
      getMcpActionLogConfigErrors({ MCP_ACTION_LOG_STORAGE_ENABLED: true }),
    ).toEqual([
      expect.objectContaining({ path: "MCP_ACTION_LOG_STORAGE_ENABLED" }),
    ]);
  });

  it("requires storage and a non-empty secret before enabling writes", () => {
    const errors = getMcpActionLogConfigErrors({
      MCP_ACTION_LOG_WRITES_ENABLED: true,
      MCP_ACTION_LOG_SECRET: "   ",
    });
    expect(errors.map(error => error.path)).toEqual([
      "MCP_ACTION_LOG_WRITES_ENABLED",
      "MCP_ACTION_LOG_SECRET",
    ]);
  });

  it("accepts the fully enabled production configuration", () => {
    expect(
      getMcpActionLogConfigErrors({
        MCP_ACTION_LOG_STORAGE_ENABLED: true,
        MCP_ACTION_LOG_WRITES_ENABLED: true,
        MCP_ACTION_LOG_SECRET: "secret",
        USE_DB_AUTHENTICATION: true,
      }),
    ).toEqual([]);
  });
});
