import type { Response } from "express";
import { agentStatusController } from "../agent-status";
import type { RequestWithAuth } from "../types";
import {
  supabaseGetAgentByIdDirect,
  supabaseGetAgentRequestByIdDirect,
} from "../../../lib/supabase-jobs";
import { getJobFromGCS } from "../../../lib/gcs-jobs";
import { supabase_service } from "../../../services/supabase";

jest.mock("../../../lib/supabase-jobs", () => ({
  supabaseGetAgentByIdDirect: jest.fn(),
  supabaseGetAgentRequestByIdDirect: jest.fn(),
}));

jest.mock("../../../lib/gcs-jobs", () => ({
  getJobFromGCS: jest.fn(),
}));

jest.mock("../../../services/supabase", () => ({
  supabase_service: {
    rpc: jest.fn(),
  },
}));

describe("agentStatusController", () => {
  const baseReq = {
    params: { jobId: "job-123" },
    auth: { team_id: "team-123" },
  } as RequestWithAuth<{ jobId: string }, any, any>;

  const buildRes = () =>
    ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }) as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns model from agent options", async () => {
    (supabaseGetAgentRequestByIdDirect as jest.Mock).mockResolvedValue({
      team_id: "team-123",
      created_at: "2025-01-01T00:00:00Z",
    });
    (supabaseGetAgentByIdDirect as jest.Mock).mockResolvedValue({
      id: "job-123",
      is_successful: true,
      options: { model: "spark-1-mini" },
      created_at: "2025-01-01T00:00:00Z",
      credits_cost: 10,
    });
    (getJobFromGCS as jest.Mock).mockResolvedValue({ result: "ok" });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ model: "spark-1-mini" }),
    );
  });

  it("defaults model to spark-1-pro when missing", async () => {
    (supabaseGetAgentRequestByIdDirect as jest.Mock).mockResolvedValue({
      team_id: "team-123",
      created_at: "2025-01-01T00:00:00Z",
    });
    (supabaseGetAgentByIdDirect as jest.Mock).mockResolvedValue({
      id: "job-123",
      is_successful: false,
      options: null,
      created_at: "2025-01-01T00:00:00Z",
      credits_cost: 5,
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ model: "spark-1-pro" }),
    );
  });

  it("returns creditsUsed from agent record when completed", async () => {
    (supabaseGetAgentRequestByIdDirect as jest.Mock).mockResolvedValue({
      team_id: "team-123",
      created_at: "2025-01-01T00:00:00Z",
    });
    (supabaseGetAgentByIdDirect as jest.Mock).mockResolvedValue({
      id: "job-123",
      is_successful: true,
      options: { model: "spark-1-pro" },
      created_at: "2025-01-01T00:00:00Z",
      credits_cost: 42,
    });
    (getJobFromGCS as jest.Mock).mockResolvedValue({ result: "ok" });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ creditsUsed: 42, status: "completed" }),
    );
    expect(supabase_service.rpc).not.toHaveBeenCalled();
  });

  it("returns creditsUsed from RPC when agent is still processing", async () => {
    (supabaseGetAgentRequestByIdDirect as jest.Mock).mockResolvedValue({
      team_id: "team-123",
      created_at: "2025-01-01T00:00:00Z",
    });
    (supabaseGetAgentByIdDirect as jest.Mock).mockResolvedValue(null);
    (supabase_service.rpc as jest.Mock).mockResolvedValue({
      data: [{ credits_billed: 15 }],
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ creditsUsed: 15, status: "processing" }),
    );
    expect(supabase_service.rpc).toHaveBeenCalledWith(
      "credits_billed_by_crawl_id_2",
      { i_crawl_id: "job-123" },
      { get: true },
    );
  });

  it("returns creditsUsed 0 when RPC returns no data during processing", async () => {
    (supabaseGetAgentRequestByIdDirect as jest.Mock).mockResolvedValue({
      team_id: "team-123",
      created_at: "2025-01-01T00:00:00Z",
    });
    (supabaseGetAgentByIdDirect as jest.Mock).mockResolvedValue(null);
    (supabase_service.rpc as jest.Mock).mockResolvedValue({
      data: [],
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ creditsUsed: 0, status: "processing" }),
    );
  });

  it("returns creditsUsed 0 when RPC fails during processing", async () => {
    (supabaseGetAgentRequestByIdDirect as jest.Mock).mockResolvedValue({
      team_id: "team-123",
      created_at: "2025-01-01T00:00:00Z",
    });
    (supabaseGetAgentByIdDirect as jest.Mock).mockResolvedValue(null);
    (supabase_service.rpc as jest.Mock).mockRejectedValue(
      new Error("DB connection failed"),
    );

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ creditsUsed: 0, status: "processing" }),
    );
  });
});
