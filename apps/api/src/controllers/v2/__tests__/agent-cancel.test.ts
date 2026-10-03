import type { Response } from "express";
import type { Mock } from "vitest";
import { getAgentJobAccess } from "../../../lib/operational-job-access";
import { agentCancelController } from "../agent-cancel";
import type { AgentCancelResponse, RequestWithAuth } from "../types";

vi.mock("../../../lib/operational-job-access", () => ({
  getAgentJobAccess: vi.fn(),
}));

describe("agentCancelController", () => {
  const req = {
    params: { jobId: "job-123" },
    auth: { team_id: "team-123" },
  } as RequestWithAuth<{ jobId: string }, AgentCancelResponse, any>;

  const buildRes = () =>
    ({
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }) as unknown as Response<AgentCancelResponse>;

  beforeEach(() => {
    vi.clearAllMocks();
    (getAgentJobAccess as Mock).mockResolvedValue({
      teamId: "team-123",
      expiresAtMs: Date.now() + 60_000,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the terminal-state conflict from extract-v3", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Agent already finished" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = buildRes();

    await agentCancelController(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Agent already finished",
    });
  });

  it("does not report success when extract-v3 rejects cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );
    const res = buildRes();

    await agentCancelController(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Failed to cancel agent",
    });
  });

  it("preserves the public error for repeated cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: "Agent has already been cancelled" }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const res = buildRes();

    await agentCancelController(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Agent is already cancelled",
    });
  });
});
