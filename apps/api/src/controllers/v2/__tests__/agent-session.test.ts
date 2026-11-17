import type { Response } from "express";
import type { Mock } from "vitest";
import { getAgentJobAccess } from "../../../lib/operational-job-access";
import { getExtractV3AgentStatus } from "../../../lib/extract-v3-status";
import {
  agentFeedbackController,
  agentOptionsController,
  agentResultController,
  agentSettingsController,
  agentShareController,
  agentSharedRunController,
} from "../agent-session";

vi.mock("../../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      EXTRACT_V3_BETA_URL: "http://agent.test",
      AGENT_INTEROP_SECRET: "interop-secret",
    },
  };
});

vi.mock("../../../lib/operational-job-access", () => ({
  getAgentJobAccess: vi.fn(),
}));

vi.mock("../../../lib/extract-v3-status", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/extract-v3-status")>()),
  getExtractV3AgentStatus: vi.fn(),
}));

const JOB_ID = "019e6f45-7778-727d-adf0-0abe9d5062b6";
const SHARE_ID = "5b0b1f43-3c1b-4e4d-9a3e-5d0f6f9a2b11";

function buildReq(overrides: Record<string, unknown> = {}) {
  return {
    method: "GET",
    params: { jobId: JOB_ID },
    auth: { team_id: "team-123" },
    body: undefined,
    ...overrides,
  } as any;
}

const buildRes = () =>
  ({
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  }) as unknown as Response;

function stubUpstream(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function expectInteropCall(
  fetchMock: Mock,
  url: string,
  method: string,
  teamId = "team-123",
) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [calledUrl, init] = fetchMock.mock.calls[0];
  expect(calledUrl).toBe(url);
  expect(init.method).toBe(method);
  expect(init.headers).toMatchObject({
    Authorization: "Bearer interop-secret",
    "x-team-id": teamId,
  });
}

describe("agent session routes", () => {
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

  const ownedRoutes: [
    string,
    (req: any, res: Response) => Promise<unknown>,
    Record<string, unknown>,
  ][] = [
    ["like", agentFeedbackController("like"), { method: "POST" }],
    ["dislike", agentFeedbackController("dislike"), { method: "POST" }],
    ["options", agentOptionsController, {}],
    ["settings", agentSettingsController, {}],
    ["share", agentShareController, { method: "POST" }],
  ];

  it.each(ownedRoutes)(
    "%s returns 404 without calling the agent service for another team's run",
    async (_name, controller, overrides) => {
      (getAgentJobAccess as Mock).mockResolvedValue({
        teamId: "team-other",
        expiresAtMs: Date.now() + 60_000,
      });
      const fetchMock = stubUpstream({});
      const res = buildRes();

      await controller(buildReq(overrides), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Agent job not found",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "like",
      agentFeedbackController("like"),
      "POST",
      `/internal/extracts/${JOB_ID}/like`,
    ],
    [
      "dislike",
      agentFeedbackController("dislike"),
      "POST",
      `/internal/extracts/${JOB_ID}/dislike`,
    ],
    [
      "options",
      agentOptionsController,
      "GET",
      `/internal/extracts/${JOB_ID}/options`,
    ],
    [
      "settings",
      agentSettingsController,
      "GET",
      `/internal/extracts/${JOB_ID}/settings`,
    ],
    [
      "share",
      agentShareController,
      "POST",
      `/internal/extracts/${JOB_ID}/share`,
    ],
    [
      "share revoke",
      agentShareController,
      "DELETE",
      `/internal/extracts/${JOB_ID}/share`,
    ],
  ] as const)(
    "%s forwards with the interop secret and the caller's team",
    async (_name, controller, method, path) => {
      const fetchMock = stubUpstream({ success: true });
      const res = buildRes();

      await controller(buildReq({ method }), res);

      expectInteropCall(fetchMock, `http://agent.test${path}`, method);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true });
    },
  );

  it("leaves ownership of a run past its job-access row to the agent service", async () => {
    (getAgentJobAccess as Mock).mockResolvedValue(null);
    const fetchMock = stubUpstream({ error: "Extract not found" }, 404);
    const res = buildRes();

    await agentOptionsController(buildReq(), res);

    expectInteropCall(
      fetchMock,
      `http://agent.test/internal/extracts/${JOB_ID}/options`,
      "GET",
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("maps an agent service failure to a 500", async () => {
    stubUpstream({ error: "boom" }, 502);
    const res = buildRes();

    await agentFeedbackController("like")(buildReq({ method: "POST" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Agent service request failed.",
    });
  });

  it("forwards a validated settings update", async () => {
    const fetchMock = stubUpstream({ success: true });
    const res = buildRes();

    await agentSettingsController(
      buildReq({ method: "PATCH", body: { hidden: true } }),
      res,
    );

    expectInteropCall(
      fetchMock,
      `http://agent.test/internal/extracts/${JOB_ID}/settings`,
      "PATCH",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      hidden: true,
    });
  });

  it("rejects a settings update with unknown fields", async () => {
    const fetchMock = stubUpstream({ success: true });
    const res = buildRes();

    await agentSettingsController(
      buildReq({ method: "PATCH", body: { team_id: "team-other" } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("result", () => {
    it("returns the run, asking the agent service as the caller's team", async () => {
      (getExtractV3AgentStatus as Mock).mockResolvedValue({
        success: true,
        id: JOB_ID,
        status: "success",
        data: { answer: 42 },
      });
      const res = buildRes();

      await agentResultController(buildReq(), res);

      expect(getExtractV3AgentStatus).toHaveBeenCalledWith(JOB_ID, "team-123");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: "success", data: { answer: 42 } }),
      );
    });

    it("returns 410 for a zero data retention run past its retention", async () => {
      (getAgentJobAccess as Mock).mockResolvedValue({
        teamId: "team-123",
        expiresAtMs: Date.now() + 60_000,
        zeroDataRetentionMinutes: 10,
      });
      (getExtractV3AgentStatus as Mock).mockResolvedValue({
        success: true,
        id: JOB_ID,
        status: "success",
        data: { answer: 42 },
        completedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });
      const res = buildRes();

      await agentResultController(buildReq(), res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, code: "zdr_expired" }),
      );
    });

    it("returns 404 for another team's run", async () => {
      (getAgentJobAccess as Mock).mockResolvedValue({
        teamId: "team-other",
        expiresAtMs: Date.now() + 60_000,
      });
      const res = buildRes();

      await agentResultController(buildReq(), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(getExtractV3AgentStatus).not.toHaveBeenCalled();
    });
  });

  describe("shared run", () => {
    const shareReq = (teamId: string, shareId = SHARE_ID) =>
      buildReq({ params: { shareId }, auth: { team_id: teamId } });

    it("refuses an ordinary API key", async () => {
      const fetchMock = stubUpstream({});
      const res = buildRes();

      await agentSharedRunController(shareReq("team-123"), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a malformed share id", async () => {
      const res = buildRes();

      await agentSharedRunController(shareReq("preview_1", "x"), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("serves a share link to the dashboard's preview credential", async () => {
      const fetchMock = stubUpstream({ success: true, status: "success" });
      const res = buildRes();

      await agentSharedRunController(shareReq("preview_1"), res);

      expectInteropCall(
        fetchMock,
        `http://agent.test/internal/shares/${SHARE_ID}`,
        "GET",
        "preview_1",
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
