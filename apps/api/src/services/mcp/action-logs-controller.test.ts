import { describe, expect, it, vi, beforeEach } from "vitest";
import { config } from "../../config";

const mocks = vi.hoisted(() => ({
  primaryDb: { name: "primary" },
  replicaDb: { name: "replica" },
  normalize: vi.fn((body: any) => body),
  validate: vi.fn(),
  record: vi.fn().mockResolvedValue({ disposition: "stored", id: "log-id" }),
  policy: vi.fn(),
  purge: vi.fn(),
  authorize: vi.fn(),
  list: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
}));

vi.mock("../../db/connection", () => ({
  db: mocks.primaryDb,
  dbRr: mocks.replicaDb,
}));
vi.mock("./action-logs", async importOriginal => {
  const actual = await importOriginal<typeof import("./action-logs")>();
  return {
    ...actual,
    normalizeMcpActionLogInput: mocks.normalize,
    validateMcpActionLogActor: mocks.validate,
    recordMcpActionLog: mocks.record,
    resolveMcpActionLogTeamPolicy: mocks.policy,
    purgeMcpActionLogsForTeam: mocks.purge,
    authorizeMcpActionLogViewer: mocks.authorize,
    listMcpActionLogs: mocks.list,
  };
});

import {
  ingestMcpActionLogController,
  listMcpActionLogsController,
} from "../../controllers/v2/mcp-action-logs";
import { McpActionLogAuthorizationError } from "./action-logs";

function response() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(value => value);
  return res;
}

describe("MCP action log controllers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.policy.mockResolvedValue({ flags: null });
    config.MCP_ACTION_LOG_STORAGE_ENABLED = true;
    mocks.record.mockResolvedValue({ disposition: "stored", id: "log-id" });
    mocks.list.mockResolvedValue({ data: [], nextCursor: null });
  });

  it("skips persistence for teams with forced zero-data retention", async () => {
    mocks.policy.mockResolvedValue({ flags: { scrapeZDR: "forced" } });
    const res = response();
    await ingestMcpActionLogController(
      { body: { team_id: "team" } } as any,
      res,
    );
    expect(mocks.validate).toHaveBeenCalledTimes(1);
    expect(mocks.policy).toHaveBeenCalledWith(mocks.primaryDb, "team");
    expect(mocks.purge).toHaveBeenCalledWith(mocks.primaryDb, "team");
    expect(mocks.record).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "zero-data-retention", id: null }),
    );
  });

  it("fails closed when team retention policy cannot be resolved", async () => {
    mocks.policy.mockResolvedValue(null);
    const res = response();
    await ingestMcpActionLogController(
      { body: { team_id: "team" } } as any,
      res,
    );
    expect(mocks.record).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("persists validated non-ZDR events", async () => {
    const res = response();
    await ingestMcpActionLogController(
      { body: { team_id: "team" } } as any,
      res,
    );
    expect(mocks.validate).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it("authorizes listing from the authenticated API key id", async () => {
    const res = response();
    await listMcpActionLogsController(
      {
        auth: { team_id: "team" },
        acuc: { api_key_id: 42 },
        query: {},
      } as any,
      res,
    );
    expect(mocks.authorize).toHaveBeenCalledWith(mocks.primaryDb, "team", 42);
    expect(mocks.policy).toHaveBeenCalledWith(mocks.primaryDb, "team");
    expect(mocks.list).toHaveBeenCalledWith(
      mocks.replicaDb,
      "team",
      expect.any(Object),
    );
  });

  it("prefers the exact bigint API-key ID when authentication provides it", async () => {
    const res = response();
    await listMcpActionLogsController(
      {
        auth: { team_id: "team" },
        acuc: {
          api_key_id: Number("9007199254740993"),
          api_key_id_text: "9007199254740993",
        },
        query: {},
      } as any,
      res,
    );

    expect(mocks.authorize).toHaveBeenCalledWith(
      mocks.primaryDb,
      "team",
      "9007199254740993",
    );
  });

  it("returns 403 when the presented key is not owner-bound", async () => {
    mocks.authorize.mockRejectedValueOnce(
      new McpActionLogAuthorizationError("An owner-bound API key is required"),
    );
    const res = response();

    await listMcpActionLogsController(
      {
        auth: { team_id: "team" },
        acuc: { api_key_id: 42 },
        query: {},
      } as any,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("does not query storage when activity logging is disabled", async () => {
    config.MCP_ACTION_LOG_STORAGE_ENABLED = false;
    const res = response();
    await listMcpActionLogsController(
      { auth: { team_id: "team" }, acuc: { api_key_id: 42 }, query: {} } as any,
      res,
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.policy).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("does not expose retained activity to a forced-ZDR request", async () => {
    mocks.policy.mockResolvedValue({ flags: { forceZDR: true } });
    const res = response();
    await listMcpActionLogsController(
      {
        auth: { team_id: "team" },
        acuc: { api_key_id: 42 },
        query: {},
      } as any,
      res,
    );
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    expect(mocks.purge).toHaveBeenCalledWith(mocks.primaryDb, "team");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [],
      nextCursor: null,
    });
  });
});
