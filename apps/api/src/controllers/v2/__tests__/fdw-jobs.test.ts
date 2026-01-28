import type { Response } from "express";
import type { RequestWithAuth } from "../types";
import { fdwJobsController } from "../fdw-jobs";
import { fetchFdwJobs } from "../../../lib/fdw/jobs";

jest.mock("../../../config", () => ({
  config: {
    FIRECRAWL_FDW_ENABLED: true,
    CLICKHOUSE_URL: "http://localhost:8123",
  },
}));

jest.mock("../../../services/clickhouse", () => ({
  isClickhouseConfigured: () => true,
}));

jest.mock("../../../lib/fdw/jobs", () => ({
  fetchFdwJobs: jest.fn(),
}));

describe("fdwJobsController", () => {
  const buildRes = () =>
    ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }) as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects missing start/end date", async () => {
    const req = {
      query: {},
      acuc: { api_key_id: 123 },
      auth: { team_id: "team-123" },
    } as unknown as RequestWithAuth;

    const res = buildRes();
    await fdwJobsController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
      }),
    );
  });

  it("passes filters through to ClickHouse query", async () => {
    (fetchFdwJobs as jest.Mock).mockResolvedValue([]);

    const req = {
      query: {
        start_date: "2024-01-01",
        end_date: "2024-01-02",
        mode: "scrape",
        limit: "250",
        offset: "10",
      },
      acuc: { api_key_id: 123 },
      auth: { team_id: "team-123" },
    } as unknown as RequestWithAuth;

    const res = buildRes();
    await fdwJobsController(req, res);

    expect(fetchFdwJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: 123,
        mode: "scrape",
        limit: 250,
        offset: 10,
      }),
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: [],
      }),
    );
  });
});
