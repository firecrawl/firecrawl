import type { Mock } from "vitest";
import type { Response } from "express";
import { agentStatusController } from "../agent-status";
import { agentRequestSchema } from "../types";
import type { RequestWithAuth } from "../types";
import { getAgentJobAccess } from "../../../lib/operational-job-access";
import { getExtractV3AgentStatus } from "../../../lib/extract-v3-status";

vi.mock("../../../lib/operational-job-access", () => ({
  getAgentJobAccess: vi.fn(),
}));

vi.mock("../../../lib/extract-v3-status", () => ({
  getExtractV3AgentStatus: vi.fn(),
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
    (getAgentJobAccess as Mock).mockResolvedValue({
      teamId: "team-123",
      expiresAtMs: Date.now() + 60_000,
    });
    (getExtractV3AgentStatus as Mock).mockResolvedValue({
      id: "job-123",
      success: true,
      status: "success",
      model: "spark-1-mini",
      data: { result: "ok" },
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ model: "spark-1-mini" }),
    );
  });

  it("defaults model to spark-1-pro when missing", async () => {
    (getAgentJobAccess as Mock).mockResolvedValue({
      teamId: "team-123",
      expiresAtMs: Date.now() + 60_000,
    });
    (getExtractV3AgentStatus as Mock).mockResolvedValue({
      id: "job-123",
      success: true,
      status: "failed",
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ model: "spark-1-pro" }),
    );
  });
  it("returns effort from agent options", async () => {
    (getAgentJobAccess as Mock).mockResolvedValue({
      teamId: "team-123",
      expiresAtMs: Date.now() + 60_000,
    });
    (getExtractV3AgentStatus as Mock).mockResolvedValue({
      id: "job-123",
      success: true,
      status: "success",
      model: "spark-2",
      effort: "high",
      data: { result: "ok" },
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ model: "spark-2", effort: "high" }),
    );
  });

  it("leaves effort undefined when the agent options omit it", async () => {
    (getAgentJobAccess as Mock).mockResolvedValue({
      teamId: "team-123",
      expiresAtMs: Date.now() + 60_000,
    });
    (getExtractV3AgentStatus as Mock).mockResolvedValue({
      id: "job-123",
      success: true,
      status: "failed",
      model: "spark-2",
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as Mock).mock.calls[0][0];
    expect(body.model).toBe("spark-2");
    expect(body.effort).toBeUndefined();
  });

  it("returns terminal state and result metadata from extract-v3", async () => {
    (getAgentJobAccess as Mock).mockResolvedValue({
      teamId: "team-123",
      expiresAtMs: Date.now() + 60_000,
    });
    (getExtractV3AgentStatus as Mock).mockResolvedValue({
      id: "job-123",
      success: true,
      status: "success",
      model: "spark-2",
      effort: "medium",
      data: { result: "ok" },
      message: "Done",
      threadId: "thread-123",
      threadTurn: 2,
      mode: "chat",
      creditsUsed: 7,
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        data: { result: "ok" },
        message: "Done",
        threadId: "thread-123",
        threadTurn: 2,
        mode: "chat",
        creditsUsed: 7,
      }),
    );
  });

  it.each([
    // python-sdk < 4.37.1 cannot parse "spark-2" and is lied to
    ["python-sdk@4.37.0", "spark-1-pro"],
    ["python-sdk@4.0.0", "spark-1-pro"],
    ["python-sdk@3.99.99", "spark-1-pro"],
    // a prerelease of the fix may predate the Literal widening, so it
    // gets the lie too
    ["python-sdk@4.37.1rc0", "spark-1-pro"],
    // everything else sees the real model
    ["python-sdk@4.37.1", "spark-2"],
    ["python-sdk@4.38.0", "spark-2"],
    ["python-sdk@5.0.0", "spark-2"],
    ["js-sdk@4.0.0", "spark-2"],
    ["api", "spark-2"],
  ] as const)(
    "reports a spark-2 job to %s as %s",
    async (origin, expectedModel) => {
      (getAgentJobAccess as Mock).mockResolvedValue({
        teamId: "team-123",
        expiresAtMs: Date.now() + 60_000,
        clientOrigin: origin,
      });
      (getExtractV3AgentStatus as Mock).mockResolvedValue({
        id: "job-123",
        success: true,
        status: "failed",
        model: "spark-2",
      });

      const res = buildRes();
      await agentStatusController(baseReq, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ model: expectedModel }),
      );
    },
  );

  it("keeps a genuine spark-1 model truthful even for old python-sdk clients", async () => {
    (getAgentJobAccess as Mock).mockResolvedValue({
      teamId: "team-123",
      expiresAtMs: Date.now() + 60_000,
      clientOrigin: "python-sdk@4.37.0",
    });
    (getExtractV3AgentStatus as Mock).mockResolvedValue({
      id: "job-123",
      success: true,
      status: "failed",
      model: "spark-1-mini",
    });

    const res = buildRes();
    await agentStatusController(baseReq, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ model: "spark-1-mini" }),
    );
  });
});

describe("agentRequestSchema model and effort resolution", () => {
  const base = { prompt: "Find the pricing page" };

  it.each(["spark-1-pro", "spark-1-mini", "spark-2"] as const)(
    "redirects %s to spark-2 and leaves effort undefined",
    model => {
      const parsed = agentRequestSchema.parse({ ...base, model });

      expect(parsed.model).toBe("spark-2");
      expect(parsed.effort).toBeUndefined();
    },
  );

  it.each(["low", "medium", "high"] as const)(
    "resolves effort %s to spark-2 and keeps the effort",
    effort => {
      const parsed = agentRequestSchema.parse({ ...base, effort });

      expect(parsed.model).toBe("spark-2");
      expect(parsed.effort).toBe(effort);
    },
  );

  it("accepts spark-2 with effort, keeping both", () => {
    const parsed = agentRequestSchema.parse({
      ...base,
      model: "spark-2",
      effort: "high",
    });

    expect(parsed.model).toBe("spark-2");
    expect(parsed.effort).toBe("high");
  });

  it.each(["spark-1-pro", "spark-1-mini"] as const)(
    "accepts effort with retired preset %s, redirecting to spark-2",
    model => {
      const parsed = agentRequestSchema.parse({
        ...base,
        model,
        effort: "low",
      });

      expect(parsed.model).toBe("spark-2");
      expect(parsed.effort).toBe("low");
    },
  );

  it("defaults to spark-2 when the caller sends neither field", () => {
    const parsed = agentRequestSchema.parse({ ...base });

    expect(parsed.model).toBe("spark-2");
    expect(parsed.effort).toBeUndefined();
  });

  it("rejects an unknown model name", () => {
    expect(() =>
      agentRequestSchema.parse({ ...base, model: "spark-9-unreleased" }),
    ).toThrow();
  });

  it("rejects an unknown effort level", () => {
    expect(() =>
      agentRequestSchema.parse({ ...base, effort: "extreme" }),
    ).toThrow();
  });
});
