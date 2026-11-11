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
