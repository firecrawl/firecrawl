vi.mock("../../../lib/crawl-regex", async () => {
  const { z } = await import("zod");
  return {
    addPathRegexIssues: vi.fn(),
    pathPatternsSchema: z.array(z.string()),
  };
});
import { agentController } from "../agent";
import { agentRequestSchema } from "../types";
import { config } from "../../../config";
import { agentConsumeFreeRequestIfLeft } from "../../../db/rpc";
import { logger } from "../../../lib/logger";
import { logRequest } from "../../../services/logging/log_job";
import { fetchAgentThread } from "../agent-thread";
vi.mock("../../../lib/logger", () => {
  const logger = { info: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return { logger };
});
vi.mock("../../../services/logging/log_job", () => ({ logRequest: vi.fn() }));
vi.mock("../../../lib/external-request-id", () => ({
  externalRequestId: () => undefined,
}));
vi.mock("../../../config", () => ({
  config: {
    EXTRACT_V3_BETA_URL: "https://agent.example",
    USE_DB_AUTHENTICATION: false,
    AGENT_INTEROP_SECRET: "test",
  },
}));
vi.mock("../../../db/rpc", () => ({ agentConsumeFreeRequestIfLeft: vi.fn() }));
vi.mock("../../../lib/threat-protection/request", () => ({
  resolveThreatProtection: vi.fn().mockResolvedValue({}),
  checkUrlsAgainstThreatPolicy: vi.fn(),
}));
vi.mock("../../../lib/scrape-billing", () => ({
  calculateThreatScanCredits: vi.fn(),
}));
vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn(),
}));
vi.mock("../../../lib/siem-logging", () => ({
  emitRejectedScrapeActivityEvents: vi.fn(),
}));
vi.mock("../agent-thread", () => ({
  fetchAgentThread: vi.fn(),
  threadErrorFor: vi.fn(),
}));
describe("Agent Alexandria rollout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (config as any).USE_DB_AUTHENTICATION = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([undefined, false, true])(
    "starts with rollout flag %s",
    async exchangeRetrieve => {
      const req = {
        body: {
          prompt: "Find government contracts",
          exchange: { enabled: true },
        },
        auth: { team_id: "team-test" },
        acuc: { flags: { exchangeRetrieve }, api_key: "test-key" },
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await agentController(req as any, res as any);
      expect(res.status).toHaveBeenCalledWith(200);
      const body = JSON.parse(
        vi.mocked(fetch).mock.calls[0][1]!.body as string,
      );
      expect(body.exchange).toEqual({ enabled: true });
      expect(body.teamId).toBe("team-test");
    },
  );
  it.each([false, true])(
    "preserves ordinary requests and ZDR (forced=%s)",
    async forced => {
      const req = {
        body: { prompt: "Find government contracts" },
        auth: { team_id: "team-test" },
        acuc: { flags: { forceZDR: forced }, api_key: "test-key" },
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await agentController(req as any, res as any);
      expect(res.status).toHaveBeenCalledWith(forced ? 400 : 200);
      expect(fetch).toHaveBeenCalledTimes(forced ? 0 : 1);
    },
  );
});

describe("Agent schema intake", () => {
  const request = (schema: unknown) => ({
    body: { prompt: "Find the details", schema },
    auth: { team_id: "team-test" },
    acuc: { flags: {}, api_key: "test-key" },
  });
  const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });

  beforeEach(() => {
    vi.clearAllMocks();
    (config as any).USE_DB_AUTHENTICATION = true;
    vi.mocked(agentConsumeFreeRequestIfLeft).mockResolvedValue([
      { consumed: true },
    ] as any);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }),
    );
  });
  afterEach(() => {
    (config as any).USE_DB_AUTHENTICATION = false;
    vi.unstubAllGlobals();
  });

  it.each([
    ["zero", 0],
    ["empty string", ""],
    ["async schema", { $async: true, type: "object" }],
    ["OpenAPI example", { type: "string", example: "a" }],
    ["unknown format", { type: "string", format: "phone" }],
    ["vendor keyword", { type: "object", propertyOrdering: ["name"] }],
    [
      "schema wrapper",
      { name: "result", strict: true, schema: { type: "object" } },
    ],
  ])(
    "rejects %s before consuming a free request or logging",
    async (_, schema) => {
      await expect(
        agentController(request(schema) as any, response() as any),
      ).rejects.toThrow("Invalid JSON schema:");
      expect(agentConsumeFreeRequestIfLeft).not.toHaveBeenCalled();
      expect(logRequest).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([0, "", { type: "bogus" }, { $async: true, type: "object" }])(
    "rejects an invalid inherited schema before admission: %j",
    async schema => {
      vi.mocked(fetchAgentThread).mockResolvedValue({
        status: 200,
        json: async () => ({ thread: { runs: [{ schema }] } }),
      } as Response);
      const req = request(undefined);
      await expect(
        agentController(
          {
            ...req,
            body: {
              ...req.body,
              threadId: "018f0000-0000-7000-8000-000000000000",
            },
          } as any,
          response() as any,
        ),
      ).rejects.toThrow("Invalid JSON schema:");
      expect(agentConsumeFreeRequestIfLeft).not.toHaveBeenCalled();
      expect(logRequest).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, { type: "object" }])(
    "admits a valid continuation with requested schema %j",
    async schema => {
      vi.mocked(fetchAgentThread).mockResolvedValue({
        status: 200,
        json: async () => ({
          thread: {
            runs: [
              {
                schema:
                  schema === undefined ? { type: "object" } : { type: "bogus" },
              },
            ],
          },
        }),
      } as Response);
      const req = request(schema);
      const res = response();
      await agentController(
        {
          ...req,
          body: {
            ...req.body,
            threadId: "018f0000-0000-7000-8000-000000000000",
          },
        } as any,
        res as any,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(agentConsumeFreeRequestIfLeft).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, { thread: { runs: [] } }])(
    "does not consume quota when the inherited schema cannot be read: %j",
    async body => {
      vi.mocked(fetchAgentThread).mockResolvedValue({
        status: 200,
        json: async () => body,
      } as Response);
      const req = request(undefined);
      const res = response();
      await agentController(
        {
          ...req,
          body: {
            ...req.body,
            threadId: "018f0000-0000-7000-8000-000000000000",
          },
        } as any,
        res as any,
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(agentConsumeFreeRequestIfLeft).not.toHaveBeenCalled();
      expect(logRequest).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, false, true, {}])(
    "accepts an absent or compilable schema %j",
    schema => {
      expect(
        agentRequestSchema.safeParse({ prompt: "Find the details", schema })
          .success,
      ).toBe(true);
    },
  );

  it("accepts x-* annotations, matching extract-v3", () => {
    expect(
      agentRequestSchema.safeParse({
        prompt: "Find the details",
        schema: {
          type: "object",
          "x-purpose": "source data",
          properties: { name: { type: "string", "x-source": "title" } },
        },
      }).success,
    ).toBe(true);
  });

  it("returns a recognized upstream schema rejection as a public 400", async () => {
    const error = 'Invalid schema: unknown format "phone"';
    vi.mocked(fetch).mockResolvedValue({
      status: 400,
      text: async () => JSON.stringify({ success: false, error }),
    } as Response);
    const res = response();

    await agentController(request({ type: "object" }) as any, res as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "BAD_REQUEST",
      error,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    [400, { success: false, error: "Internal exception" }],
    [503, { success: false, error: "Invalid schema: not an intake error" }],
  ])(
    "does not expose an unrecognized upstream %i response",
    async (status, body) => {
      vi.mocked(fetch).mockResolvedValue({
        status,
        text: async () => JSON.stringify(body),
      } as Response);
      const res = response();

      await agentController(request({ type: "object" }) as any, res as any);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Failed to passthrough agent request.",
      });
      expect(logger.error).toHaveBeenCalled();
    },
  );
});
