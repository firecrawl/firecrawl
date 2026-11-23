import type { Response } from "express";
import { extractStatusController } from "../extract-status";
import { getExtractJobAccess } from "../../../lib/operational-job-access";
import {
  agentStatusUnavailable,
  getExtractV3AgentStatus,
} from "../../../lib/extract-v3-status";

vi.mock("../../../config", () => ({
  config: {
    USE_DB_AUTHENTICATION: true,
  },
}));

vi.mock("../../../lib/operational-job-access", () => ({
  getExtractJobAccess: vi.fn(),
}));

vi.mock("../../../lib/extract-v3-status", async () => {
  const actual = await vi.importActual<
    typeof import("../../../lib/extract-v3-status")
  >("../../../lib/extract-v3-status");
  return {
    ...actual,
    getExtractV3AgentStatus: vi.fn(),
  };
});

vi.mock("../../../lib/extract/extract-redis", () => ({
  getExtract: vi.fn(),
  getExtractExpiry: vi.fn(),
  getExtractResult: vi.fn(),
}));

vi.mock("../../../lib/gcs-jobs", () => ({
  getJobFromGCS: vi.fn(),
}));

vi.mock("../../../lib/job-state-store", () => ({
  readExtractJobState: vi.fn(),
}));

describe("extract status for an agent job", () => {
  it("returns 503 and Retry-After when the agent status lookup is unavailable", async () => {
    vi.mocked(getExtractJobAccess).mockResolvedValue({
      teamId: "team-123",
      kind: "agent",
      expiresAtMs: Date.now() + 60_000,
    });
    vi.mocked(getExtractV3AgentStatus).mockRejectedValue(
      agentStatusUnavailable(),
    );

    const res = {
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await extractStatusController(
      {
        params: { jobId: "job-123" },
        auth: { team_id: "team-123" },
      } as any,
      res,
    );

    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "agent_status_unavailable",
      error: "Agent status is temporarily unavailable. Retry the request.",
    });
  });
});
