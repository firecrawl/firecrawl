import type { Response } from "express";
import type { RequestWithAuth } from "../types";

const mocks = vi.hoisted(() => ({
  client: null as { query: ReturnType<typeof vi.fn> } | null,
  query: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../../../lib/clickhouse-client", () => ({
  get clickhouseClient() {
    return mocks.client;
  },
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    child: vi.fn(() => ({ error: mocks.loggerError })),
  },
}));

import { activityController } from "../activity";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";

function makeReq(query: Record<string, string> = {}) {
  return {
    query,
    auth: { team_id: TEAM_ID },
  } as unknown as RequestWithAuth;
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
}

function mockRows(rows: Record<string, unknown>[]) {
  mocks.query.mockResolvedValue({
    json: vi.fn().mockResolvedValue(rows),
  });
}

describe("activityController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client = { query: mocks.query };
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 501 without querying when ClickHouse is not configured", async () => {
    mocks.client = null;
    const res = makeRes();

    await activityController(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(501);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "This endpoint is only available if ClickHouse is configured.",
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("preserves endpoint and cursor validation before querying", async () => {
    const endpointRes = makeRes();
    await activityController(makeReq({ endpoint: "invalid" }), endpointRes);

    expect(endpointRes.status).toHaveBeenCalledWith(400);
    expect(endpointRes.json).toHaveBeenCalledWith({
      success: false,
      error:
        "Invalid endpoint filter. Must be one of: alexandria, scrape, crawl, batch_scrape, search, extract, llmstxt, deep_research, map, agent, browser, interact",
    });

    const cursorRes = makeRes();
    await activityController(
      makeReq({ cursor: "bm8tc2VwYXJhdG9y" }),
      cursorRes,
    );

    expect(cursorRes.status).toHaveBeenCalledWith(400);
    expect(cursorRes.json).toHaveBeenCalledWith({
      success: false,
      error: "Invalid cursor.",
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("queries public_requests for the authenticated team and 24-hour window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T12:34:56.789Z"));
    mockRows([]);
    const res = makeRes();

    await activityController(makeReq(), res);

    expect(mocks.query).toHaveBeenCalledOnce();
    const options = mocks.query.mock.calls[0][0];
    expect(options.query).toContain("FROM public_requests");
    expect(options.query).toContain("team_id = {teamId: UUID}");
    expect(options.query).toContain(
      "created_at >= {windowStart: DateTime64(3)}",
    );
    expect(options.query).toContain("ORDER BY created_at DESC, id DESC");
    expect(options.query_params).toEqual({
      teamId: TEAM_ID,
      windowStart: "2026-09-15 12:34:56.789",
      limit: 51,
    });
    expect(options.format).toBe("JSONEachRow");
  });

  it("applies endpoint and stable keyset filters and fetches limit plus one", async () => {
    const cursorCreatedAt = "2026-09-16T10:00:00.123Z";
    const cursorId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const cursor = Buffer.from(`${cursorCreatedAt}:${cursorId}`).toString(
      "base64url",
    );
    const rows = [
      {
        id: "99999999-9999-9999-9999-999999999999",
        kind: "scrape",
        api_version: "v2",
        created_at: "2026-09-16 09:00:00.000",
        target_hint: "https://first.example",
      },
      {
        id: "88888888-8888-8888-8888-888888888888",
        kind: "scrape",
        api_version: "v2",
        created_at: "2026-09-16 08:00:00.000",
        target_hint: null,
      },
      {
        id: "77777777-7777-7777-7777-777777777777",
        kind: "scrape",
        api_version: "v1",
        created_at: "2026-09-16 07:00:00.000",
        target_hint: "https://extra.example",
      },
    ];
    mockRows(rows);
    const res = makeRes();

    await activityController(
      makeReq({ endpoint: "scrape", cursor, limit: "2" }),
      res,
    );

    const options = mocks.query.mock.calls[0][0];
    expect(options.query).toContain("kind = {endpoint: String}");
    expect(options.query).toContain(
      "(created_at < {cursorCreatedAt: DateTime64(3)} OR (created_at = {cursorCreatedAt: DateTime64(3)} AND id < {cursorId: UUID}))",
    );
    expect(options.query_params).toEqual(
      expect.objectContaining({
        teamId: TEAM_ID,
        endpoint: "scrape",
        cursorCreatedAt: "2026-09-16 10:00:00.123",
        cursorId,
        limit: 3,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [
        {
          id: rows[0].id,
          endpoint: "scrape",
          api_version: "v2",
          created_at: rows[0].created_at,
          target: "https://first.example",
        },
        {
          id: rows[1].id,
          endpoint: "scrape",
          api_version: "v2",
          created_at: rows[1].created_at,
          target: null,
        },
      ],
      cursor: Buffer.from(`${rows[1].created_at}:${rows[1].id}`).toString(
        "base64url",
      ),
      has_more: true,
    });
  });

  it("does not emit a cursor when there is no extra row", async () => {
    mockRows([
      {
        id: "99999999-9999-9999-9999-999999999999",
        kind: "crawl",
        api_version: "v2",
        created_at: "2026-09-16 09:00:00.000",
        target_hint: "https://example.com",
      },
    ]);
    const res = makeRes();

    await activityController(makeReq({ limit: "1" }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: null, has_more: false }),
    );
  });

  it("returns 500 when the ClickHouse query fails", async () => {
    const error = new Error("ClickHouse unavailable");
    mocks.query.mockRejectedValue(error);
    const res = makeRes();

    await activityController(makeReq(), res);

    expect(mocks.loggerError).toHaveBeenCalledWith("Failed to fetch activity", {
      error,
    });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Failed to fetch activity.",
    });
  });
});

it("accepts the Alexandria activity filter and includes historical scrape rows", async () => {
  mockRows([]);
  const res = makeRes();
  await activityController(makeReq({ endpoint: "alexandria" }), res);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(mocks.query).toHaveBeenCalled();
  expect(mocks.query.mock.calls.at(-1)?.[0].query).toContain(
    "(kind = 'alexandria' OR (kind = 'scrape' AND startsWith(target_hint, 'alexandria:')))",
  );
});
