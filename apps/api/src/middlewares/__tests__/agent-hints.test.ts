import express from "express";
import request from "supertest";
import { agentHintsMiddleware } from "../agent-hints";

function appFor(
  {
    endpoint = "search",
    body = { success: true, data: {} },
    status = 200,
  } = {} as any,
) {
  const app = express();
  app.use(express.json());
  app.post("/", agentHintsMiddleware(endpoint), (_req, res) => {
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
    const body = {
      success: true,
      data: { web: [{ url: "https://example.com", description: "excerpt" }] },
      warning: "existing",
    };
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

  it("does not add static feedback guidance to an otherwise hint-free result", async () => {
    const response = await request(appFor())
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body).not.toHaveProperty("agent_hints");
  });

  it("preserves failure status, code, and details without inventing hints", async () => {
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
});
