import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("MCP action log migration", () => {
  const train1Migration = readFileSync(
    resolve(
      __dirname,
      "../../db/migrations/20260712000100_create_mcp_action_logs.sql",
    ),
    "utf8",
  );
  const train2SearchResourceMigration = readFileSync(
    resolve(
      __dirname,
      "../../db/migrations/20260717000100_allow_mcp_search_action_log_resource.sql",
    ),
    "utf8",
  );

  const train1MigrationHash = createHash("sha256")
    .update(train1Migration)
    .digest("hex");

  it("enforces terminal statuses, auth shape, and one event per request", () => {
    expect(train1Migration).toContain("CREATE TABLE public.mcp_action_logs");
    expect(train1Migration).not.toContain("CREATE TABLE IF NOT EXISTS");
    expect(train1Migration).toContain("status IN ('success', 'error')");
    expect(train1Migration).toContain("mcp_action_logs_auth_shape");
    expect(train1Migration).toContain("UNIQUE (team_id, request_id)");
  });

  it("has bounded retention and an expiry cleanup index", () => {
    expect(train1Migration).toContain("interval '30 days'");
    expect(train1Migration).toContain("mcp_action_logs_expires_idx");
  });

  it("contains only the metadata fields allowed by the runtime contract", () => {
    expect(train1Migration).not.toMatch(
      /user_agent|raw_ip|arguments|request_body|response_body/,
    );
    expect(train1Migration).toContain("mcp.firecrawl.dev/v2/mcp-oauth");
    expect(train1Migration).not.toContain("mcp.firecrawl.dev/v2/mcp-search");
  });

  it("keeps the Train 1 create-table migration byte-for-byte frozen", () => {
    expect(train1MigrationHash).toBe(
      "989d77c5cb4b699003205d24bf844a44fd91c113c55e6e3eba6f2d8c34104602",
    );
  });

  it("adds mcp-search as a Train 2 forward-only resource constraint upgrade", () => {
    expect(train2SearchResourceMigration).not.toContain("CREATE TABLE");
    expect(train2SearchResourceMigration).toMatch(/(?:^|\n)BEGIN;\n[\s\S]*\nCOMMIT;\s*$/);
    expect(train2SearchResourceMigration).toContain(
      "DROP CONSTRAINT IF EXISTS mcp_action_logs_resource_check",
    );
    expect(train2SearchResourceMigration).toContain(
      "ADD CONSTRAINT mcp_action_logs_resource_check CHECK",
    );
    expect(train2SearchResourceMigration).toContain(
      "https://mcp.firecrawl.dev/v2/mcp",
    );
    expect(train2SearchResourceMigration).toContain(
      "https://mcp.firecrawl.dev/v2/mcp-oauth",
    );
    expect(train2SearchResourceMigration).toContain(
      "https://mcp.firecrawl.dev/v2/mcp-search",
    );
  });
});
