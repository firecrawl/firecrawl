import express from "express";
import request from "supertest";
import { config } from "../../config";
import { agentHintsMiddleware, setAgentHintFeedback } from "../agent-hints";

vi.mock("../../config", () => ({ config: { USE_DB_AUTHENTICATION: true } }));
const jobId = "0199412e-7590-7000-8000-000000000001";
function appFor(
  {
    endpoint = "search",
    body = { success: true, data: {} },
    status = 200,
    feedback = true,
    zdr = false,
    preview = false,
    optOut = false,
  } = {} as any,
) {
  const app = express();
  app.use(express.json());
  app.post("/", agentHintsMiddleware(endpoint), (req, res) => {
    Object.assign(req, {
      auth: { team_id: preview ? "preview_keyless_x" : "team" },
      acuc: { flags: { searchFeedbackOptOut: optOut } },
    });
    if (feedback) setAgentHintFeedback(res, jobId, zdr);
    res.status(status).json(body);
  });
  return app;
}

describe("agent hint response middleware", () => {
  it("leaves the original envelope unchanged by default", async () => {
    const body = { success: true, data: { web: [] }, warning: "existing" };
    const response = await request(appFor({ body })).post("/").send({});
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(body);
  });

  it("adds top-level metadata only when explicitly enabled", async () => {
    const body = { success: true, data: { web: [] }, warning: "existing" };
    const response = await request(appFor({ body }))
      .post("/")
      .set("X-Firecrawl-Agent-Hints", " TRUE ")
      .send({});
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject(body);
    expect(response.body.agent_hints).toHaveLength(1);
  });

  it("values other than true preserve the original envelope", async () => {
    const body = {
      success: true,
      data: { tools: [{ options: [], response: {} }] },
    };
    const response = await request(appFor({ body }))
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "false")
      .send({});
    expect(response.body).toEqual(body);
  });

  it.each([
    { preview: true },
    { optOut: true },
    { zdr: true },
    { feedback: false },
  ])("does not invent accepted feedback for %j", async settings => {
    const response = await request(appFor(settings))
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body).not.toHaveProperty("agent_hints");
  });

  it("omits feedback when database authentication is unavailable", async () => {
    config.USE_DB_AUTHENTICATION = false;
    try {
      const response = await request(appFor())
        .post("/")
        .set("X-Firecrawl-Agent-Hints", "true")
        .send({});
      expect(response.body).not.toHaveProperty("agent_hints");
    } finally {
      config.USE_DB_AUTHENTICATION = true;
    }
  });

  it("preserves failure status, code, and details without bogus feedback", async () => {
    const body = {
      success: false,
      error: "Bad URL",
      code: "BAD_REQUEST",
      details: [{ field: "url" }],
    };
    const response = await request(appFor({ body, status: 400 }))
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual(body);
  });

  it("does not attach feedback to an unpersisted Alexandria scrape id", async () => {
    const body = { success: true, scrape_id: jobId, data: { alexandria: [] } };
    const response = await request(
      appFor({ endpoint: "scrape", body, feedback: false }),
    )
      .post("/")
      .send({ alexandria: [] });
    expect(response.body).toEqual(body);
  });
});
