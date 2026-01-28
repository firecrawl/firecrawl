import type { Response } from "express";
import type { RequestWithAuth } from "../types";
import { fdwJobResultsController } from "../fdw-job-results";
import { fetchFdwJobOwnership } from "../../../lib/fdw/jobs";
import { getJobFromGCS } from "../../../lib/gcs-jobs";
import { getExtractResult } from "../../../lib/extract/extract-redis";

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
  fetchFdwJobOwnership: jest.fn(),
}));

jest.mock("../../../lib/gcs-jobs", () => ({
  getJobFromGCS: jest.fn(),
}));

jest.mock("../../../lib/extract/extract-redis", () => ({
  getExtractResult: jest.fn(),
}));

describe("fdwJobResultsController", () => {
  const buildRes = () =>
    ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }) as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects empty job_ids", async () => {
    const req = {
      body: {
        job_ids: [],
      },
      acuc: { api_key_id: 123 },
      auth: { team_id: "team-123" },
    } as unknown as RequestWithAuth<{}, any, { job_ids: string[] }>;

    const res = buildRes();
    await fdwJobResultsController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it("returns per-job errors when unauthorized", async () => {
    (fetchFdwJobOwnership as jest.Mock).mockResolvedValue([
      { job_id: "11111111-1111-1111-1111-111111111111", mode: "scrape" },
    ]);
    (getJobFromGCS as jest.Mock).mockResolvedValue([{ ok: true }]);

    const req = {
      body: {
        job_ids: [
          "11111111-1111-1111-1111-111111111111",
          "22222222-2222-2222-2222-222222222222",
        ],
      },
      acuc: { api_key_id: 123 },
      auth: { team_id: "team-123" },
    } as unknown as RequestWithAuth<{}, any, { job_ids: string[] }>;

    const res = buildRes();
    await fdwJobResultsController(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.arrayContaining([
          expect.objectContaining({
            job_id: "22222222-2222-2222-2222-222222222222",
            found: false,
            error: "unauthorized_or_not_found",
          }),
        ]),
      }),
    );
  });

  it("falls back to Redis for extract results", async () => {
    (fetchFdwJobOwnership as jest.Mock).mockResolvedValue([
      { job_id: "33333333-3333-3333-3333-333333333333", mode: "extract" },
    ]);
    (getJobFromGCS as jest.Mock).mockResolvedValue(null);
    (getExtractResult as jest.Mock).mockResolvedValue({ data: "ok" });

    const req = {
      body: {
        job_ids: ["33333333-3333-3333-3333-333333333333"],
      },
      acuc: { api_key_id: 123 },
      auth: { team_id: "team-123" },
    } as unknown as RequestWithAuth<{}, any, { job_ids: string[] }>;

    const res = buildRes();
    await fdwJobResultsController(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: [
          expect.objectContaining({
            job_id: "33333333-3333-3333-3333-333333333333",
            found: true,
            result_json: { data: "ok" },
          }),
        ],
      }),
    );
  });
});
