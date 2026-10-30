import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const ch = vi.hoisted(() => ({
  client: { query: vi.fn() } as { query: ReturnType<typeof vi.fn> } | null,
  logMcpActionLog: vi.fn(),
}));
vi.mock("../../lib/clickhouse-client", () => ({
  get clickhouseClient() {
    return ch.client;
  },
}));
vi.mock("../logging/log_job", () => ({
  logMcpActionLog: ch.logMcpActionLog,
}));
vi.mock("../../db/rpc", () => ({
  authCreditUsageChunkFromTeam: vi.fn((db: any, teamId: string) =>
    db.getTeamPolicy(teamId),
  ),
}));
import {
  authorizeMcpActionLogViewer,
  decodeMcpActionLogCursor,
  listMcpActionLogs,
  normalizeMcpActionLogInput,
  recordMcpActionLog,
  resolveMcpActionLogTeamPolicy,
  validateMcpActionLogActor,
} from "./action-logs";

const TEAM_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const REQUEST_ID = "00000000-0000-4000-8000-000000000003";
const UUID_V7_REQUEST_ID = "0190a5d4-7b10-7cc3-98c4-0242ac120002";

function input(overrides: Record<string, unknown> = {}) {
  return normalizeMcpActionLogInput({
    team_id: TEAM_ID,
    api_key_id: "123",
    auth_type: "api-key",
    tool_name: "firecrawl_scrape",
    status: "success",
    request_id: REQUEST_ID,
    resource: "https://mcp.firecrawl.dev/v2/mcp",
    ...overrides,
  });
}

describe("MCP action log contract", () => {
  it("preserves decimal API-key IDs beyond JavaScript's safe integer range", () => {
    expect(input({ api_key_id: "9007199254740993" }).api_key_id).toBe(
      "9007199254740993",
    );
  });

  it.each([
    "",
    "0",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e3",
    " 1",
    "1 ",
    "abc",
    "9223372036854775808",
  ])("rejects malformed API-key ID %j", apiKeyId => {
    expect(() => input({ api_key_id: apiKeyId })).toThrow(
      "api_key_id must be a positive decimal string",
    );
  });

  it("accepts only terminal, attributable events for canonical MCP resources", () => {
    expect(input()).toMatchObject({
      auth_type: "api-key",
      request_id: REQUEST_ID,
      resource: "https://mcp.firecrawl.dev/v2/mcp",
    });
    expect(
      input({
        auth_type: "oauth",
        api_key_id: null,
        user_id: USER_ID,
        oauth_client_id: "claude-web",
        resource: "https://mcp.firecrawl.dev/v2/mcp-oauth",
      }),
    ).toMatchObject({ auth_type: "oauth", user_id: USER_ID });

    expect(() => input({ status: "started" })).toThrow(
      "status must be success or error",
    );
    expect(() => input({ request_id: "req-1" })).toThrow(
      "request_id must be a valid UUID",
    );
    expect(() =>
      input({ resource: "https://mcp.firecrawl.dev/v2/mcp?key=x" }),
    ).toThrow("resource must be a canonical hosted MCP URL");
    expect(() => input({ resource: "https://example.com/v2/mcp" })).toThrow(
      "resource must be a canonical hosted MCP URL",
    );
  });

  it("accepts UUIDv7 request IDs", () => {
    expect(input({ request_id: UUID_V7_REQUEST_ID }).request_id).toBe(
      UUID_V7_REQUEST_ID,
    );
  });

  it("rejects inconsistent authentication fields and raw user agent metadata", () => {
    expect(() => input({ api_key_id: null })).toThrow(
      "api_key_id is required for api-key events",
    );
    expect(() => input({ user_id: USER_ID })).toThrow(
      "api-key events must not include OAuth identity fields",
    );
    expect(() =>
      input({
        auth_type: "oauth",
        api_key_id: null,
        user_id: null,
        oauth_client_id: "client",
      }),
    ).toThrow("user_id is required for oauth events");
    expect(() => input({ auth_type: "keyless" })).toThrow(
      "auth_type must be oauth or api-key",
    );
    expect(input({ user_agent: "Claude/1.0" })).not.toHaveProperty(
      "user_agent",
    );
    expect(() => input({ arguments: { url: "https://private.test" } })).toThrow(
      "arguments is not accepted",
    );
    expect(() => input({ client_name: "Bearer fco_secret" })).toThrow(
      "client_name must not contain secret-like values",
    );
    expect(() => input({ client_name: "fcmcp_secret" })).toThrow(
      "client_name must not contain secret-like values",
    );
  });

  it("accepts the hosted MCP search resource", () => {
    expect(
      input({ resource: "https://mcp.firecrawl.dev/v2/mcp-search" }).resource,
    ).toBe("https://mcp.firecrawl.dev/v2/mcp-search");
  });

  it("stores an optional, normalized objective with secret-like values redacted", () => {
    expect(input()).toMatchObject({ objective: null, api_job_id: null });
    expect(
      input({
        tool_name: "firecrawl_find_tools",
        objective: "Pick a tool to extract product prices",
      }),
    ).toMatchObject({
      objective: "Pick a tool to extract product prices",
      api_job_id: null,
    });
    expect(input({ objective: null }).objective).toBeNull();
    expect(input({ objective: "   " }).objective).toBeNull();
    expect(
      input({ objective: "  Compare pricing pages\nfor three vendors  " })
        .objective,
    ).toBe("Compare pricing pages for three vendors");
    expect(
      input({ objective: "Check docs using Bearer abc.def and fc-123abc" })
        .objective,
    ).toBe("Check docs using [redacted] and [redacted]");
    expect(input({ objective: "Find\u0085the\u009fdocs" }).objective).toBe(
      "Find the docs",
    );
    const started = performance.now();
    expect(input({ objective: "eyJ-".repeat(16_000) }).objective).toBe(
      "[redacted]",
    );
    expect(performance.now() - started).toBeLessThan(500);
    const cutJwt = `${`fc-${"x".repeat(96)} `.repeat(39)}eyJhbGciOi.eyJ${"a".repeat(200)}.c2ln`;
    expect(input({ objective: cutJwt }).objective).toBe(
      `${"[redacted] ".repeat(39)}[redacted]`,
    );
    expect(input({ objective: "x".repeat(1200) }).objective).toBe(
      "x".repeat(1000),
    );
    expect(input({ objective: `${"x".repeat(999)}\u{1F600}` }).objective).toBe(
      "x".repeat(999),
    );
    expect(() => input({ objective: 42 })).toThrow(
      "objective must be a string",
    );
  });

  it("stores an optional API job ID with the standard text limits", () => {
    expect(input({ api_job_id: " 0190a5d4-7b10-7cc3 " }).api_job_id).toBe(
      "0190a5d4-7b10-7cc3",
    );
    expect(input({ api_job_id: "" }).api_job_id).toBeNull();
    expect(() => input({ api_job_id: "j".repeat(129) })).toThrow(
      "api_job_id must be at most 128 characters",
    );
    expect(() => input({ api_job_id: "fc-secret" })).toThrow(
      "api_job_id must not contain secret-like values",
    );
    expect(() => input({ api_job_id: 7 })).toThrow(
      "api_job_id must be a string",
    );
  });

  it("stores an optional coarse error code and rejects anything but snake_case", () => {
    expect(input().error_code).toBeNull();
    expect(
      input({ status: "error", error_code: "rate_limited" }).error_code,
    ).toBe("rate_limited");
    expect(
      input({ status: "error", error_code: "scrape_all_engines_failed" })
        .error_code,
    ).toBe("scrape_all_engines_failed");
    expect(input({ error_code: "" }).error_code).toBeNull();
    for (const value of [
      "Rate limit exceeded",
      "https://example.com",
      "RATE_LIMITED",
      "rate_",
      "rate__limited",
      "fcmcp_abc123",
      "x".repeat(65),
      429,
    ]) {
      expect(() => input({ error_code: value })).toThrow(
        "error_code must be a lowercase snake_case code",
      );
    }
  });

  it("stores the optional per-call fields the hosted MCP reads itself", () => {
    expect(input()).toMatchObject({
      mcp_origin: null,
      mcp_client: null,
      mcp_client_source: null,
      llm_model: null,
      duration_ms: null,
      invalid_arguments: [],
      rate_limit_retry: null,
    });
    expect(
      input({
        status: "error",
        error_class: "InvalidArguments",
        mcp_origin: "mcp-ua-codex-cli-rs",
        mcp_client: "codex",
        mcp_client_source: "user_agent",
        llm_model: " gpt-6.1-sol ",
        duration_ms: 55,
        invalid_arguments: ["limit:invalid_type", "*:unrecognized_keys"],
      }),
    ).toMatchObject({
      mcp_origin: "mcp-ua-codex-cli-rs",
      mcp_client: "codex",
      mcp_client_source: "user_agent",
      llm_model: "gpt-6.1-sol",
      duration_ms: 55,
      invalid_arguments: ["limit:invalid_type", "*:unrecognized_keys"],
    });
    expect(input({ duration_ms: 0 }).duration_ms).toBe(0);
    for (const rate_limit_retry of [
      "recovered",
      "failed",
      "over_cap",
      "not_retryable",
    ]) {
      expect(input({ rate_limit_retry }).rate_limit_retry).toBe(
        rate_limit_retry,
      );
    }
    expect(input({ invalid_arguments: ["(root):invalid_type"] })).toMatchObject(
      { invalid_arguments: ["(root):invalid_type"] },
    );
  });

  it("rejects malformed per-call fields", () => {
    expect(() => input({ mcp_client_source: "header" })).toThrow(
      "mcp_client_source must be client_info, user_agent or oauth",
    );
    for (const duration_ms of [-1, 1.5, "55", 2_147_483_648]) {
      expect(() => input({ duration_ms })).toThrow(
        "duration_ms must be a non-negative integer",
      );
    }
    for (const invalid_arguments of [
      "limit:invalid_type",
      ["limit"],
      ["limit:Invalid Type"],
      ["my secret value:custom"],
      Array.from({ length: 11 }, (_, i) => `a${i}:invalid_type`),
    ]) {
      expect(() => input({ invalid_arguments })).toThrow(
        "invalid_arguments must be at most 10 <argument>:<issue> labels",
      );
    }
    for (const rate_limit_retry of ["retrying", "RECOVERED", 1]) {
      expect(() => input({ rate_limit_retry })).toThrow(
        "rate_limit_retry must be recovered, failed, over_cap or not_retryable",
      );
    }
    expect(() => input({ llm_model: "m".repeat(129) })).toThrow(
      "llm_model must be at most 128 characters",
    );
    expect(() => input({ mcp_client: "fc-secret" })).toThrow(
      "mcp_client must not contain secret-like values",
    );
  });

  it("stores optional session and thread ids with their sources", () => {
    expect(input()).toMatchObject({
      session_id: null,
      session_source: null,
      thread_id: null,
      thread_source: null,
    });
    expect(
      input({
        session_id: "AbC-123_xyz.789:abcdefg",
        session_source: "token",
        thread_id: "0b7c9a8e-1f2d-4e3c-9b8a-7f6e5d4c3b2a",
        thread_source: "argument",
      }),
    ).toMatchObject({
      session_id: "AbC-123_xyz.789:abcdefg",
      session_source: "token",
      thread_id: "0b7c9a8e-1f2d-4e3c-9b8a-7f6e5d4c3b2a",
      thread_source: "argument",
    });
    expect(
      input({
        session_id: "s".repeat(128),
        thread_id: "t",
        thread_source: "minted",
      }),
    ).toMatchObject({
      session_id: "s".repeat(128),
      session_source: null,
      thread_id: "t",
      thread_source: "minted",
    });
    expect(
      input({
        thread_id: "0f8fad5b-d9cb-869f-a165-70867728950e",
        thread_source: "client",
      }),
    ).toMatchObject({
      thread_id: "0f8fad5b-d9cb-869f-a165-70867728950e",
      thread_source: "client",
    });
  });

  it("stores a credential-like session or thread id as null instead of rejecting the event", async () => {
    ch.logMcpActionLog.mockReset().mockResolvedValue(undefined);
    await expect(
      recordMcpActionLog(
        input({
          session_id: "fc-FAKESECRET1234567890",
          session_source: "trace",
        }),
      ),
    ).resolves.toEqual({ disposition: "accepted", id: REQUEST_ID });
    expect(ch.logMcpActionLog.mock.calls[0][0]).toMatchObject({
      id: REQUEST_ID,
      session_id: null,
      session_source: null,
    });

    expect(
      input({
        session_id: "fc-FAKESECRET1234567890",
        session_source: "token",
        thread_id: "sk-FAKESECRET1234567890",
        thread_source: "argument",
      }),
    ).toMatchObject({
      session_id: null,
      session_source: null,
      thread_id: null,
      thread_source: null,
    });
    expect(
      input({
        session_id: "fc-FAKESECRET1234567890",
        thread_id: "thread-1",
        thread_source: "minted",
      }),
    ).toMatchObject({
      session_id: null,
      thread_id: "thread-1",
      thread_source: "minted",
    });
    for (const id of [
      "x_fc-FAKESECRET1234567890",
      "_sk-FAKESECRET1234567890",
      "s_fcmcp_FAKESECRET1234567890",
    ]) {
      expect(
        input({
          session_id: id,
          session_source: "token",
          thread_id: id,
          thread_source: "client",
        }),
      ).toMatchObject({
        session_id: null,
        session_source: null,
        thread_id: null,
        thread_source: null,
      });
    }
    expect(() =>
      input({
        session_id: "fc-FAKESECRET1234567890",
        session_source: "header",
      }),
    ).toThrow("session_source must be one of token, trace, sse");
  });

  it("rejects malformed session and thread fields", () => {
    for (const session_id of ["s".repeat(129), "has space", "a/b", 42]) {
      expect(() => input({ session_id })).toThrow(
        "session_id must be 1-128 letters, digits, dots, underscores, colons or hyphens",
      );
    }
    expect(() => input({ thread_id: "é" })).toThrow(
      "thread_id must be 1-128 letters, digits, dots, underscores, colons or hyphens",
    );
    expect(() =>
      input({ session_id: "abc", session_source: "header" }),
    ).toThrow("session_source must be one of token, trace, sse");
    expect(() => input({ thread_id: "abc", thread_source: "Session" })).toThrow(
      "thread_source must be one of argument, session, minted, client",
    );
    expect(() => input({ session_source: "token" })).toThrow(
      "session_source requires session_id",
    );
    expect(() => input({ thread_source: "session" })).toThrow(
      "thread_source requires thread_id",
    );
  });

  it("validates API-key and OAuth actors against the claimed team", async () => {
    const apiKeyDb = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ id: 123 }]) }),
        }),
      })),
    };
    await expect(
      validateMcpActionLogActor(apiKeyDb as any, input()),
    ).resolves.toBeUndefined();

    const missingDb = {
      select: vi.fn(() => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      })),
    };
    await expect(
      validateMcpActionLogActor(missingDb as any, input()),
    ).rejects.toThrow("api_key_id does not belong to team_id");

    await expect(
      validateMcpActionLogActor(
        missingDb as any,
        input({
          auth_type: "oauth",
          api_key_id: null,
          user_id: USER_ID,
          oauth_client_id: "client",
        }),
      ),
    ).rejects.toThrow("user_id does not belong to team_id");

    const oauthRows = [[{ id: 123 }], [{ user_id: USER_ID }]];
    const oauthDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(oauthRows.shift() ?? []),
          }),
        }),
      }),
    };
    await expect(
      validateMcpActionLogActor(
        oauthDb as any,
        input({
          auth_type: "oauth",
          user_id: USER_ID,
          oauth_client_id: "client",
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves retention policy through the explicitly supplied primary DB", async () => {
    const primaryDb = {
      getTeamPolicy: vi
        .fn()
        .mockResolvedValue([{ team_id: TEAM_ID, flags: { forceZDR: true } }]),
    };
    await expect(
      resolveMcpActionLogTeamPolicy(primaryDb as any, TEAM_ID),
    ).resolves.toEqual({ flags: { forceZDR: true } });
    expect(primaryDb.getTeamPolicy).toHaveBeenCalledWith(TEAM_ID);
  });

  it("publishes accepted events keyed by the MCP request ID", async () => {
    ch.logMcpActionLog.mockReset().mockResolvedValue(undefined);
    await expect(
      recordMcpActionLog(
        input({
          objective: "Find the refund policy",
          api_job_id: REQUEST_ID,
          error_code: "rate_limited",
          user_agent: "Claude/1.0",
          mcp_origin: "mcp-ua-codex-cli-rs",
          mcp_client: "codex-cli-rs",
          mcp_client_source: "user_agent",
          llm_model: "gpt-6.1-sol",
          duration_ms: 55,
          invalid_arguments: ["limit:invalid_type"],
          rate_limit_retry: "recovered",
          session_id: "AbC-123_xyz.789:abcdefg",
          session_source: "trace",
          thread_id: "AbC-123_xyz.789:abcdefg",
          thread_source: "session",
        }),
      ),
    ).resolves.toEqual({ disposition: "accepted", id: REQUEST_ID });
    const row = ch.logMcpActionLog.mock.calls[0][0];
    expect(row).toMatchObject({
      id: REQUEST_ID,
      request_id: REQUEST_ID,
      team_id: TEAM_ID,
      api_key_id: "123",
      objective: "Find the refund policy",
      api_job_id: REQUEST_ID,
      error_code: "rate_limited",
      mcp_origin: "mcp-ua-codex-cli-rs",
      mcp_client: "codex-cli-rs",
      mcp_client_source: "user_agent",
      llm_model: "gpt-6.1-sol",
      duration_ms: 55,
      invalid_arguments: ["limit:invalid_type"],
      rate_limit_retry: "recovered",
      session_id: "AbC-123_xyz.789:abcdefg",
      session_source: "trace",
      thread_id: "AbC-123_xyz.789:abcdefg",
      thread_source: "session",
    });
    expect(row).not.toHaveProperty("user_agent");

    ch.logMcpActionLog.mockRejectedValueOnce(new Error("publish failed"));
    await expect(recordMcpActionLog(input())).rejects.toThrow("publish failed");
  });

  it("requires the API-key owner to be a team admin or owner for listing", async () => {
    const rows = [
      [{ owner_id: USER_ID }],
      [{ role: "admin" }],
      [{ owner_id: USER_ID }],
      [{ role: "admin" }],
    ];
    const predicates: unknown[] = [];
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: (predicate: unknown) => {
            predicates.push(predicate);
            return { limit: () => Promise.resolve(rows.shift() ?? []) };
          },
        }),
      })),
    };
    await expect(
      authorizeMcpActionLogViewer(db as any, TEAM_ID, 123),
    ).resolves.toEqual({ userId: USER_ID, role: "admin" });

    await expect(
      authorizeMcpActionLogViewer(db as any, TEAM_ID, "9007199254740993"),
    ).resolves.toEqual({ userId: USER_ID, role: "admin" });
    const keyLookup = new PgDialect().sqlToQuery(predicates[2] as any);
    expect(keyLookup.params).toEqual(["9007199254740993", TEAM_ID]);
    const membershipLookup = new PgDialect().sqlToQuery(predicates[3] as any);
    expect(membershipLookup.params).toEqual([USER_ID, TEAM_ID]);

    const noOwner = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      }),
    };
    await expect(
      authorizeMcpActionLogViewer(noOwner as any, TEAM_ID, 123),
    ).rejects.toThrow("An owner-bound API key is required");
  });

  it("paginates non-expired ClickHouse rows with stable cursors", async () => {
    const rows = [
      {
        id: REQUEST_ID,
        api_key_id: "9007199254740993",
        created_at: "2026-07-10T10:03:00.123456789Z",
      },
      {
        id: USER_ID,
        api_key_id: null,
        created_at: "2026-07-10T10:02:00.000000000Z",
      },
    ];
    ch.client = {
      query: vi.fn().mockResolvedValue({ json: async () => rows }),
    };
    const result = await listMcpActionLogs(TEAM_ID, { limit: 1 });
    expect(result.data).toEqual(rows.slice(0, 1));
    expect(result.data[0].api_key_id).toBe("9007199254740993");
    expect(decodeMcpActionLogCursor(result.nextCursor!)).toEqual({
      id: rows[0].id,
      created_at: rows[0].created_at,
    });
    const first = ch.client.query.mock.calls[0][0];
    expect(first.query).toContain("FROM mcp_action_logs AS log FINAL");
    expect(first.query).toContain("log.team_id = {teamId: UUID}");
    expect(first.query).toContain("INTERVAL 30 DAY");
    expect(first.query).not.toContain("{beforeId: UUID}");
    expect(first.query_params).toEqual({ teamId: TEAM_ID, limit: 2 });

    await listMcpActionLogs(TEAM_ID, { limit: 500, cursor: result.nextCursor });
    const second = ch.client.query.mock.calls[1][0];
    expect(second.query).toContain(
      "(log.created_at, log.id) < (parseDateTime64BestEffort({before: String}, 9), {beforeId: UUID})",
    );
    expect(second.query_params).toEqual({
      teamId: TEAM_ID,
      limit: 101,
      before: rows[0].created_at,
      beforeId: rows[0].id,
    });

    expect(() => decodeMcpActionLogCursor("bad")).toThrow("cursor is invalid");
    await expect(listMcpActionLogs(TEAM_ID, { cursor: "bad" })).rejects.toThrow(
      "cursor is invalid",
    );

    const complete = await listMcpActionLogs(TEAM_ID, { limit: 2 });
    expect(complete.data[1].api_key_id).toBeNull();
    expect(complete.nextCursor).toBeNull();
  });

  it("never selects the objective or API job ID for the team-readable list", async () => {
    ch.client = { query: vi.fn().mockResolvedValue({ json: async () => [] }) };
    await listMcpActionLogs(TEAM_ID);
    const sql = ch.client.query.mock.calls[0][0].query as string;
    const columns = sql.slice(0, sql.indexOf(" FROM "));
    expect(columns).toContain("tool_name");
    expect(columns).not.toContain("objective");
    expect(columns).not.toContain("api_job_id");
  });

  it("reports storage as unavailable when the read fails", async () => {
    ch.client = { query: vi.fn().mockRejectedValue(new Error("timeout")) };
    await expect(listMcpActionLogs(TEAM_ID)).rejects.toThrow(
      "MCP action log storage is unavailable",
    );
  });

  it("reports storage as unavailable without ClickHouse", async () => {
    ch.client = null;
    await expect(listMcpActionLogs(TEAM_ID)).rejects.toThrow(
      "MCP action log storage is unavailable",
    );
  });
});
