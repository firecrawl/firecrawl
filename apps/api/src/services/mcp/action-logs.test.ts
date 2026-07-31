import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("../../db/rpc", () => ({
  authCreditUsageChunkFromTeam: vi.fn((db: any, teamId: string) =>
    db.getTeamPolicy(teamId),
  ),
}));
import {
  authorizeMcpActionLogViewer,
  decodeMcpActionLogCursor,
  encodeMcpActionLogCursor,
  listMcpActionLogs,
  normalizeMcpActionLogInput,
  purgeMcpActionLogsForTeam,
  recordMcpActionLog,
  resolveMcpActionLogTeamPolicy,
  startMcpActionLogRetentionWorker,
  startMcpActionLogRetentionWorkerIfEnabled,
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

  it("reports stored and duplicate deliveries correctly", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const db = { insert: () => ({ values }) };

    await expect(recordMcpActionLog(db as any, input())).resolves.toEqual({
      disposition: "duplicate",
      id: null,
    });
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect((values.mock.calls as any)[0][0]).not.toHaveProperty("user_agent");

    returning.mockResolvedValueOnce([{ id: REQUEST_ID }]);
    await expect(recordMcpActionLog(db as any, input())).resolves.toEqual({
      disposition: "stored",
      id: REQUEST_ID,
    });
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

  it("purges all retained rows for a team on the supplied primary DB", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const db = { delete: vi.fn(() => ({ where })) };
    await purgeMcpActionLogsForTeam(db as any, TEAM_ID);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("runs bounded retention independently on an unrefed, stoppable timer", async () => {
    const db = { execute: vi.fn().mockResolvedValue(undefined) };
    let callback: (() => void) | undefined;
    const timer = { unref: vi.fn() };
    const clear = vi.fn();
    const worker = startMcpActionLogRetentionWorker({
      db,
      intervalMs: 1234,
      setIntervalFn: (next, interval) => {
        callback = next;
        expect(interval).toBe(1234);
        return timer;
      },
      clearIntervalFn: clear,
    });
    await worker.ready;
    expect(db.execute).toHaveBeenCalled();
    expect(timer.unref).toHaveBeenCalledTimes(1);
    callback?.();
    await vi.waitFor(() =>
      expect(db.execute.mock.calls.length).toBeGreaterThan(1),
    );
    worker.stop();
    expect(clear).toHaveBeenCalledWith(timer);
  });

  it("does not touch storage when retention is disabled", () => {
    const db = { execute: vi.fn() };
    const setIntervalFn = vi.fn();
    expect(
      startMcpActionLogRetentionWorkerIfEnabled({
        enabled: false,
        db,
        setIntervalFn,
      }),
    ).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
    expect(setIntervalFn).not.toHaveBeenCalled();
  });

  it("paginates non-expired rows with stable cursors", async () => {
    const rows = [
      {
        id: REQUEST_ID,
        api_key_id: "9007199254740993",
        created_at: "2026-07-10T10:03:00.000Z",
      },
      { id: USER_ID, api_key_id: null, created_at: "2026-07-10T10:02:00.000Z" },
    ];
    const execute = vi.fn().mockResolvedValue(undefined);
    const db = {
      execute,
      select: () => ({
        from() {
          return this;
        },
        where() {
          return this;
        },
        orderBy() {
          return this;
        },
        limit: () => Promise.resolve(rows),
      }),
    };
    const result = await listMcpActionLogs(db as any, TEAM_ID, { limit: 1 });
    expect(result.data).toEqual(rows.slice(0, 1));
    expect(result.data[0].api_key_id).toBe("9007199254740993");
    expect(decodeMcpActionLogCursor(result.nextCursor!)).toEqual({
      id: rows[0].id,
      created_at: rows[0].created_at,
    });
    expect(execute).not.toHaveBeenCalled();

    const cursor = encodeMcpActionLogCursor(rows[0]);
    expect(decodeMcpActionLogCursor(cursor)).toEqual({
      id: rows[0].id,
      created_at: rows[0].created_at,
    });
    expect(() => decodeMcpActionLogCursor("bad")).toThrow("cursor is invalid");

    const complete = await listMcpActionLogs(db as any, TEAM_ID, { limit: 2 });
    expect(complete.data[1].api_key_id).toBeNull();
  });
});
