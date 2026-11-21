import type { Response } from "express";
import { agentStatusController } from "../agent-status";
import { agentTraceController } from "../agent-trace";
import { agentSnapshotController } from "../agent-snapshot";
import { agentSkillController } from "../agent-skill";
import { getAgentJobAccess } from "../../../lib/operational-job-access";
import {
  ExtractV3AgentStatusError,
  getExtractV3AgentStatus,
} from "../../../lib/extract-v3-status";

vi.mock("../../../config", () => ({
  config: {
    EXTRACT_V3_BETA_URL: "https://agent.example",
    AGENT_INTEROP_SECRET: "test",
  },
}));

vi.mock("../../../lib/operational-job-access", () => ({
  getAgentJobAccess: vi.fn(),
}));

vi.mock("../../../lib/browser-sessions", () => ({
  listActiveBrowserSessionsForRequest: vi.fn().mockResolvedValue([]),
}));

const JOB_ID = "job-123";
const SNAPSHOT_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function upstream(status: number, body: unknown) {
  vi.mocked(fetch).mockResolvedValue(
    new globalThis.Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }) as any,
  );
}

function makeReq(params: Record<string, string> = {}) {
  return {
    params: { jobId: JOB_ID, ...params },
    query: {},
    auth: { team_id: "team-123" },
  } as any;
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
}

describe("agent passthroughs for zero data retention runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(getAgentJobAccess).mockResolvedValue({
      teamId: "team-123",
      expiresAtMs: Date.now() + 60_000,
    } as any);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("getExtractV3AgentStatus surfaces a 410 zdr_expired as a typed error", async () => {
    upstream(410, { code: "zdr_expired", error: "Result deleted." });

    const error = await getExtractV3AgentStatus(JOB_ID).catch(e => e);

    expect(error).toBeInstanceOf(ExtractV3AgentStatusError);
    expect(error).toMatchObject({
      status: 410,
      code: "zdr_expired",
      message: "Result deleted.",
    });
  });

  it("getExtractV3AgentStatus still throws a plain error for other failures", async () => {
    upstream(500, { error: "boom" });

    const error = await getExtractV3AgentStatus(JOB_ID).catch(e => e);

    expect(error).not.toBeInstanceOf(ExtractV3AgentStatusError);
    expect(error.message).toContain("500");
  });

  it("returns the job status when a dropped status lookup succeeds on retry", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new globalThis.Response(
          JSON.stringify({
            success: true,
            id: JOB_ID,
            status: "success",
            data: { answer: "ready" },
            model: "spark-2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ) as any,
      );
    const res = makeRes();

    await agentStatusController(makeReq(), res);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        status: "completed",
        data: { answer: "ready" },
      }),
    );
  });

  it("returns 503 instead of an unhandled 500 when the status service cannot be reached", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    const res = makeRes();

    await agentStatusController(makeReq(), res);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "agent_status_unavailable",
      error: "Agent status is temporarily unavailable. Retry the request.",
    });
  });

  it("does not retry when reading the status body times out", async () => {
    const response = new globalThis.Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    vi.spyOn(response, "json").mockRejectedValue(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
    vi.mocked(fetch).mockResolvedValue(response as any);
    const res = makeRes();

    await agentStatusController(makeReq(), res);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "2");
  });

  it("does not retry a status lookup that already timed out", async () => {
    vi.mocked(fetch).mockRejectedValue(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
    const res = makeRes();

    await agentStatusController(makeReq(), res);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "agent_status_unavailable" }),
    );
  });

  it.each([502, 503, 504])(
    "turns an upstream %s into a retryable 503 after one retry",
    async status => {
      upstream(status, { error: "Could not read this run's state; try again" });
      const res = makeRes();

      await agentStatusController(makeReq(), res);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "2");
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        code: "agent_status_unavailable",
        error: "Agent status is temporarily unavailable. Retry the request.",
      });
    },
  );

  it("keeps a 404 when the error body times out", async () => {
    const response = new globalThis.Response("", { status: 404 });
    vi.spyOn(response, "text").mockRejectedValue(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
    vi.mocked(fetch).mockResolvedValue(response as any);
    const res = makeRes();

    await agentStatusController(makeReq(), res);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "agent_not_found",
      error: "Agent job not found",
    });
  });

  it("returns 404 when the agent service has no such job", async () => {
    upstream(404, { error: "Extract not found" });
    const res = makeRes();

    await agentStatusController(makeReq(), res);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "agent_not_found",
      error: "Agent job not found",
    });
  });

  it("returns 503 when the job access lookup fails", async () => {
    vi.mocked(getAgentJobAccess).mockRejectedValue(
      new Error("Bigtable job access read failed"),
    );
    const res = makeRes();

    await agentStatusController(makeReq(), res);

    expect(fetch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "agent_status_unavailable" }),
    );
  });

  it("status forwards 410 zdr_expired", async () => {
    upstream(410, { code: "zdr_expired", error: "Result deleted." });
    const res = makeRes();

    await agentStatusController(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "zdr_expired",
      error: "Result deleted.",
    });
  });

  it("trace passes the zeroDataRetention flag through", async () => {
    const body = {
      success: true,
      id: JOB_ID,
      events: [{ type: "run.started" }],
      creditsUsed: 3,
      zeroDataRetention: true,
    };
    upstream(200, body);
    const res = makeRes();

    await agentTraceController(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(body);
  });

  it("snapshot forwards 404 zdr_no_snapshots", async () => {
    const body = { code: "zdr_no_snapshots", error: "No snapshots." };
    upstream(404, body);
    const res = makeRes();

    await agentSnapshotController(makeReq({ snapshotId: SNAPSHOT_ID }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(body);
    expect(fetch).toHaveBeenCalledWith(
      `https://agent.example/internal/extracts/${JOB_ID}/snapshots/${SNAPSHOT_ID}`,
      {
        headers: {
          Authorization: "Bearer test",
          "x-team-id": "team-123",
        },
      },
    );
  });

  it.each(["snap-1", "..%2F..%2Fother", "../../other", `${SNAPSHOT_ID}/..`])(
    "snapshot rejects a malformed snapshot id %s",
    async snapshotId => {
      const res = makeRes();

      await agentSnapshotController(makeReq({ snapshotId }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(fetch).not.toHaveBeenCalled();
      expect(getAgentJobAccess).not.toHaveBeenCalled();
    },
  );

  it("skill forwards 410 zdr_expired", async () => {
    const body = { code: "zdr_expired", error: "Expired." };
    upstream(410, body);
    const res = makeRes();

    await agentSkillController(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith(body);
  });
});
