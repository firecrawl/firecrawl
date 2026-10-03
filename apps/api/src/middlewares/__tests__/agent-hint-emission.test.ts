import express from "express";
import request from "supertest";
import { config } from "../../config";
import { trackAgentHints } from "../../lib/tracking";
import type { AgentHintEndpoint } from "../../lib/agent-hints";
import { agentHintsMiddleware } from "../agent-hints";

vi.mock("../../lib/tracking", () => ({
  trackAgentHints: vi.fn(async () => {}),
}));

function appFor({
  endpoint = "search" as AgentHintEndpoint,
  body = { success: true, data: { web: [] }, id: "job-9" } as any,
  remainingCredits = undefined as number | undefined,
  teamId = "account-team" as string | undefined,
  zeroDataRetention = false,
} = {}) {
  const app = express();
  app.use(express.json());
  app.post("/", agentHintsMiddleware(endpoint), (req, res) => {
    (req as any).auth = teamId ? { team_id: teamId } : undefined;
    (req as any).acuc = { flags: zeroDataRetention ? { forceZDR: true } : {} };
    res.locals.agentCreditsRemaining = remainingCredits;
    res.status(200).json(body);
  });
  return app;
}

const hinted = (app: express.Express, payload: object = {}) =>
  request(app).post("/").set("X-Firecrawl-Agent-Hints", "true").send(payload);

describe("agent hint emission middleware", () => {
  const originalDbAuthentication = config.USE_DB_AUTHENTICATION;

  beforeEach(() => {
    config.USE_DB_AUTHENTICATION = true;
    vi.mocked(trackAgentHints).mockClear();
  });

  afterAll(() => {
    config.USE_DB_AUTHENTICATION = originalDbAuthentication;
  });

  it("records the hint id, endpoint, job and team when a hint fires", async () => {
    const response = await hinted(appFor());

    expect(response.statusCode).toBe(200);
    expect(trackAgentHints).toHaveBeenCalledWith({
      hintIds: ["search_no_web_results"],
      endpoint: "search",
      jobId: "job-9",
      teamId: "account-team",
      zeroDataRetention: false,
    });
  });

  it("takes the job id from scrape metadata", async () => {
    await hinted(
      appFor({
        endpoint: "scrape",
        body: {
          success: true,
          data: { metadata: { statusCode: 401, scrapeId: "scrape-3" } },
        },
      }),
    );

    expect(vi.mocked(trackAgentHints).mock.calls[0][0]).toMatchObject({
      hintIds: ["scrape_interactive_auth"],
      jobId: "scrape-3",
    });
  });

  it("marks a zero-data-retention request so no row is written", async () => {
    await hinted(appFor({ zeroDataRetention: true }));

    expect(vi.mocked(trackAgentHints).mock.calls[0][0]).toMatchObject({
      zeroDataRetention: true,
    });
  });

  it("records nothing when the caller did not opt in", async () => {
    const response = await request(appFor()).post("/").send({});

    expect(response.body).toEqual({
      success: true,
      data: { web: [] },
      id: "job-9",
    });
    expect(trackAgentHints).not.toHaveBeenCalled();
  });

  it("records nothing when no hint fires", async () => {
    await hinted(
      appFor({
        body: {
          success: true,
          data: { web: [{ url: "https://example.com", markdown: "full" }] },
        },
      }),
    );

    expect(trackAgentHints).not.toHaveBeenCalled();
  });

  it("returns the same hints to the caller as before", async () => {
    const response = await hinted(appFor());

    expect(response.body.agent_hints).toEqual([
      'No web results were returned. If the task is still unresolved, use firecrawl_search again with {"query":"<broader or alternative query>","sources":["web"]}.',
    ]);
  });

  it("still answers when the emission rejects", async () => {
    vi.mocked(trackAgentHints).mockRejectedValueOnce(
      new Error("clickhouse unavailable"),
    );

    const response = await hinted(appFor());

    expect(response.statusCode).toBe(200);
    expect(response.body.agent_hints).toHaveLength(1);
  });
});
