import type { Response } from "express";
import { agentStatusController } from "../agent-status";
import type { RequestWithAuth } from "../types";
import {
  supabaseGetAgentByIdDirect,
  supabaseGetAgentRequestByIdDirect,
} from "../../../lib/supabase-jobs";
import { getJobFromGCS } from "../../../lib/gcs-jobs";

jest.mock("../../../lib/supabase-jobs", () => ({
  supabaseGetAgentByIdDirect: jest.fn(),
  supabaseGetAgentRequestByIdDirect: jest.fn(),
}));

jest.mock("../../../lib/gcs-jobs", () => ({
  getJobFromGCS: jest.fn(),
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
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ model: "spark-1-pro" }),
    );
  });
});
