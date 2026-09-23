import type { Response } from "express";
import type { RequestWithAuth } from "../types";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../../../config", () => ({
  config: {
    USE_DB_AUTHENTICATION: true,
    EXTRACT_V3_BETA_URL: "https://agent.example",
    AGENT_INTEROP_SECRET: "test",
  },
}));

vi.mock("../../../lib/clickhouse-client", () => ({
  clickhouseClient: { query: mocks.query },
}));

vi.mock("../../../db/connection", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));

import { agentListController } from "../agent-list";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";

function makeReq() {
  return {
    query: {},
    auth: { team_id: TEAM_ID },
    protocol: "https",
    host: "api.example",
  } as unknown as RequestWithAuth<{}, any>;
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
}

// The first query reads `requests`, the second reads `agents`.
function mockAgentRow(options: unknown) {
  mocks.query.mockImplementation(async ({ query }: { query: string }) => ({
    json: async () =>
      query.includes("FROM requests")
        ? [
            {
              id: AGENT_ID,
              created_at: "2026-09-23 12:00:00.000",
              target_hint: "https://example.com",
              origin: "api",
              integration: null,
            },
          ]
        : [{ id: AGENT_ID, options, is_successful: true, error: null }],
  }));
}

async function listOptions() {
  const res = makeRes();
  await agentListController(makeReq(), res);
  const body = vi.mocked(res.json).mock.calls[0][0];
  expect(body.success).toBe(true);
  expect(body.agents).toHaveLength(1);
  return body.agents[0].options;
}

describe("agentListController options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses options that ClickHouse returns as a JSON string", async () => {
    mockAgentRow(
      JSON.stringify({
        prompt: "find the price",
        urls: ["https://example.com"],
        schema: { type: "object" },
        model: "spark-2",
        threadId: "thread-1",
        threadTurn: 2,
      }),
    );

    expect(await listOptions()).toEqual({
      urls: ["https://example.com"],
      prompt: "find the price",
      schema: { type: "object" },
      model: "spark-2",
      effort: "medium",
      threadId: "thread-1",
      threadTurn: 2,
    });
  });

  it("reads a quoted threadTurn as a number", async () => {
    mockAgentRow({ prompt: "p", threadId: "thread-1", threadTurn: "3" });

    expect(await listOptions()).toMatchObject({
      threadId: "thread-1",
      threadTurn: 3,
    });
  });

  it("falls back to defaults when options do not parse", async () => {
    mockAgentRow("{not json");

    const options = await listOptions();
    expect(options).toMatchObject({ prompt: "", model: "spark-1-pro" });
    expect(options).not.toHaveProperty("threadId");
    expect(options).not.toHaveProperty("threadTurn");
  });
});
