import type { Mock } from "vitest";
import type { Response } from "express";
import { agentStatusController } from "../agent-status";
import { agentRequestSchema } from "../types";
import type { RequestWithAuth } from "../types";
import {
  supabaseGetAgentByIdDirect,
  supabaseGetAgentRequestByIdDirect,
} from "../../../lib/supabase-jobs";
import { getJobFromGCS } from "../../../lib/gcs-jobs";

vi.mock("../../../lib/supabase-jobs", () => ({
  supabaseGetAgentByIdDirect: vi.fn(),
  supabaseGetAgentRequestByIdDirect: vi.fn(),
}));

vi.mock("../../../lib/gcs-jobs", () => ({
  getJobFromGCS: vi.fn(),
}));

describe("agentStatusController", () => {
  const baseReq = {
    params: { jobId: "job-123" },
    auth: { team_id: "team-123" },
  } as RequestWithAuth<{ jobId: string }, any, any>;

  const buildRes = () =>
    ({
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }) as unknown as Response;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns model from agent options", async () => {
    (supabaseGetAgentRequestByIdDirect as Mock).mockResolvedValue({
      team_id: "team-123",
      created_at: "2025-01-01T00:00:00Z",
    });
    (supabaseGetAgentByIdDirect as Mock).mockResolvedValue({
      id: "job-123",
      is_successful: true,
      options: { model: "spark-1-mini" },
      created_at: "2025-01-01T00:00:00Z",
    });
    (getJobFromGCS as Mock).mockResolvedValue({ result: "ok" });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ model: "spark-1-mini" }),
    );
  });

  it("defaults model to spark-1-pro when missing", async () => {
    (supabaseGetAgentRequestByIdDirect as Mock).mockResolvedValue({
      team_id: "team-123",
      created_at: "2025-01-01T00:00:00Z",
    });
    (supabaseGetAgentByIdDirect as Mock).mockResolvedValue({
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
  it("returns effort from agent options", async () => {
    (supabaseGetAgentRequestByIdDirect as Mock).mockResolvedValue({
      team_id: "team-123",
      created_at: "2025-01-01T00:00:00Z",
    });
    (supabaseGetAgentByIdDirect as Mock).mockResolvedValue({
      id: "job-123",
      is_successful: true,
      options: { model: "spark-2", effort: "high" },
      created_at: "2025-01-01T00:00:00Z",
    });
    (getJobFromGCS as Mock).mockResolvedValue({ result: "ok" });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ model: "spark-2", effort: "high" }),
    );
  });

  it("leaves effort undefined when the agent options omit it", async () => {
    (supabaseGetAgentRequestByIdDirect as Mock).mockResolvedValue({
      team_id: "team-123",
      created_at: "2025-01-01T00:00:00Z",
    });
    (supabaseGetAgentByIdDirect as Mock).mockResolvedValue({
      id: "job-123",
      is_successful: false,
      options: { model: "spark-2" },
      created_at: "2025-01-01T00:00:00Z",
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as Mock).mock.calls[0][0];
    expect(body.model).toBe("spark-2");
    expect(body.effort).toBeUndefined();
  });
});

describe("agentRequestSchema model and effort resolution", () => {
  const base = { prompt: "Find the pricing page" };

  it("keeps the sent model and leaves effort undefined", () => {
    const parsed = agentRequestSchema.parse({ ...base, model: "spark-1-mini" });

    expect(parsed.model).toBe("spark-1-mini");
    expect(parsed.effort).toBeUndefined();
  });

  it.each(["low", "medium", "high"] as const)(
    "resolves effort %s to spark-2 and keeps the effort",
    effort => {
      const parsed = agentRequestSchema.parse({ ...base, effort });

      expect(parsed.model).toBe("spark-2");
      expect(parsed.effort).toBe(effort);
    },
  );

  it("rejects model and effort together, naming both fields", () => {
    let message = "";
    try {
      agentRequestSchema.parse({ ...base, model: "spark-2", effort: "low" });
    } catch (error) {
      message = (error as { issues: { message: string }[] }).issues[0].message;
    }

    expect(message).toContain("model");
    expect(message).toContain("effort");
  });

  it("falls back to the default model when the caller sends neither field", () => {
    const parsed = agentRequestSchema.parse({ ...base });

    expect(parsed.model).toBe("spark-2");
    expect(parsed.effort).toBeUndefined();
  });

  it("rejects an unknown effort level", () => {
    expect(() =>
      agentRequestSchema.parse({ ...base, effort: "extreme" }),
    ).toThrow();
  });
});
