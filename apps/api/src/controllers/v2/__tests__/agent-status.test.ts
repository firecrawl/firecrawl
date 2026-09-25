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
      expect.objectContaining({
        success: true,
        status: "failed",
        model: "spark-1-pro",
      }),
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

describe("agentRequestSchema exchange.onTermsRequired", () => {
  const base = { prompt: "Find the key business contact at exa.ai" };

  it.each(["skip", "ask"] as const)(
    "forwards onTermsRequired %s unchanged",
    onTermsRequired => {
      const parsed = agentRequestSchema.parse({
        ...base,
        exchange: { onTermsRequired },
      });

      expect(parsed.exchange).toEqual({ onTermsRequired });
    },
  );

  it("leaves onTermsRequired unset when omitted so the thread inherits it", () => {
    const parsed = agentRequestSchema.parse({
      ...base,
      exchange: { requireApproval: true },
    });

    expect(parsed.exchange).toEqual({ requireApproval: true });
    expect(parsed.exchange?.onTermsRequired).toBeUndefined();
  });

  it("accepts onTermsRequired alongside an approve continuation", () => {
    const approve = {
      approvalId: "0199aaaa-0000-7000-8000-000000000000",
      callIds: ["apollo"],
    };
    const parsed = agentRequestSchema.parse({
      ...base,
      exchange: { onTermsRequired: "ask", approve },
    });

    expect(parsed.exchange).toEqual({ onTermsRequired: "ask", approve });
  });

  it("rejects decline.callIds: a terms offer is declined as a whole", () => {
    expect(
      agentRequestSchema.safeParse({
        ...base,
        exchange: {
          decline: {
            approvalId: "0199aaaa-0000-7000-8000-000000000000",
            callIds: ["apollo"],
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each(["fail", "accept", "auto", "", true])(
    "rejects onTermsRequired %s",
    onTermsRequired => {
      expect(
        agentRequestSchema.safeParse({
          ...base,
          exchange: { onTermsRequired },
        }).success,
      ).toBe(false);
    },
  );

  it("still rejects unknown exchange fields", () => {
    expect(
      agentRequestSchema.safeParse({
        ...base,
        exchange: { onTermsRequired: "ask", autoAcceptTerms: true },
      }).success,
    ).toBe(false);
  });
});

describe("agentStatusController terms-required passthrough", () => {
  const req = {
    params: { jobId: "job-123" },
    auth: { team_id: "team-123" },
  } as RequestWithAuth<{ jobId: string }, any, any>;

  it("returns skippedProviders, requiresAction and a terms pending approval unchanged", async () => {
    const approvalId = "0199aaaa-0000-7000-8000-000000000000";
    const exchange = {
      enabled: true,
      requireApproval: false,
      onTermsRequired: "ask",
      paidCalls: 0,
      creditsUsed: null,
      skippedProviders: [
        {
          provider: "apollo",
          name: "Apollo",
          capability: "people/search",
          adds: "verified work emails and direct phone numbers",
          reason: "terms_required",
          version: "F-1.0.0",
          termsUrl: "https://www.firecrawl.dev/app/alexandria/apollo",
        },
      ],
      requiresAction: {
        type: "accept_terms",
        approvalId,
        providers: [
          {
            provider: "apollo",
            name: "Apollo",
            capability: "people/search",
            version: "F-1.0.0",
            digest: null,
            url: "https://www.firecrawl.dev/app/alexandria/apollo",
            show: {
              provider: "firecrawl",
              capability: "terms/show",
              options: { provider: "apollo" },
            },
            accept: {
              provider: "firecrawl",
              capability: "terms/accept",
              options: {
                provider: "apollo",
                version: "F-1.0.0",
                digest: null,
                confirmed: true,
              },
            },
          },
        ],
      },
    };
    const pendingApproval = {
      id: approvalId,
      kind: "terms",
      reason: "Apollo could add verified work emails.",
      calls: [],
      terms: [
        {
          provider: "apollo",
          name: "Apollo",
          version: "F-1.0.0",
          digest: null,
          url: "https://www.firecrawl.dev/app/alexandria/apollo",
        },
      ],
      resolution: null,
    };
    (getAgentJobAccess as Mock).mockResolvedValue({
      teamId: "team-123",
      expiresAtMs: Date.now() + 60_000,
    });
    (getExtractV3AgentStatus as Mock).mockResolvedValue({
      id: "job-123",
      success: true,
      status: "success",
      model: "spark-2",
      exchange,
      pendingApproval,
    });

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    await agentStatusController(req, res);

    const body = (res.json as Mock).mock.calls[0][0];
    expect(body.exchange).toEqual(exchange);
    expect(body.pendingApproval).toEqual(pendingApproval);
  });
});
