import express from "express";
import request from "supertest";
import { config } from "../../config";
import { agentHintsMiddleware } from "../agent-hints";

function appFor(
  {
    endpoint = "search",
    body = { success: true, data: {} },
    status = 200,
    remainingCredits,
    teamId = "account-team",
  } = {} as any,
) {
  const app = express();
  app.use(express.json());
  app.post("/", agentHintsMiddleware(endpoint), (req, res) => {
    (req as any).auth = { team_id: teamId };
    res.locals.agentCreditsRemaining = remainingCredits;
    res.status(status).json(body);
  });
  return app;
}

describe("agent hint response middleware", () => {
  const originalDbAuthentication = config.USE_DB_AUTHENTICATION;

  beforeEach(() => {
    config.USE_DB_AUTHENTICATION = true;
  });

  afterAll(() => {
    config.USE_DB_AUTHENTICATION = originalDbAuthentication;
  });

  it("leaves the original envelope unchanged by default", async () => {
    const body = { success: true, data: { web: [] }, warning: "existing" };
    const response = await request(appFor({ body, remainingCredits: 0 }))
      .post("/")
      .send({});
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
      .set("X-Firecrawl-Agent-Hints", "TRUE")
      .send({});
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject(body);
    expect(response.body.agent_hints).toHaveLength(1);
  });

  it.each(["false", "1", "yes"])(
    "header value %s preserves the original envelope",
    async value => {
      const body = {
        success: true,
        data: { web: [{ url: "https://example.com" }] },
      };
      const response = await request(appFor({ body, remainingCredits: 0 }))
        .post("/")
        .set("X-Firecrawl-Agent-Hints", value)
        .send({});
      expect(response.body).toEqual(body);
    },
  );

  it.each([404, 410])(
    "adds the scrape-to-search hint for page status %i",
    async statusCode => {
      const body = {
        success: true,
        data: { metadata: { statusCode } },
      };
      const response = await request(appFor({ endpoint: "scrape", body }))
        .post("/")
        .set("X-Firecrawl-Agent-Hints", "true")
        .send({});
      expect(response.body.agent_hints).toHaveLength(1);
      expect(response.body.agent_hints[0]).toContain("firecrawl_search");
      expect(response.body.agent_hints[0]).not.toContain("firecrawl_scrape");
    },
  );

  it.each([
    {
      name: "scrape 401 with a scrape ID",
      endpoint: "scrape",
      body: {
        success: true,
        data: { metadata: { statusCode: 401, scrapeId: "scrape-id" } },
      },
      expected: ["POST /v2/scrape/scrape-id/interact"],
    },
    {
      name: "truncated PDF scrape",
      endpoint: "scrape",
      body: {
        success: true,
        data: { metadata: { statusCode: 200, numPages: 5, totalPages: 47 } },
      },
      expected: ['"maxPages":47'],
    },
    {
      name: "empty web search",
      endpoint: "search",
      body: { success: true, data: { web: [] } },
      expected: ["firecrawl_search"],
    },
    {
      name: "search clustered on one origin",
      endpoint: "search",
      body: {
        success: true,
        data: {
          web: [
            { url: "https://docs.example.com/a", markdown: "a" },
            { url: "https://docs.example.com/b", markdown: "b" },
            { url: "https://docs.example.com/c", markdown: "c" },
            { url: "https://other.example.com/d", markdown: "d" },
          ],
        },
      },
      expected: ["POST /v2/map", "POST /v2/crawl"],
    },
  ])("preserves the $name hint through the middleware", async testCase => {
    const response = await request(
      appFor({ endpoint: testCase.endpoint, body: testCase.body }),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});

    expect(response.body.agent_hints).toHaveLength(1);
    for (const text of testCase.expected) {
      expect(response.body.agent_hints[0]).toContain(text);
    }
  });

  it("does not suggest Map or Crawl to a keyless Search caller", async () => {
    const body = {
      success: true,
      data: {
        web: [
          { url: "https://docs.example.com/a", markdown: "a" },
          { url: "https://docs.example.com/b", markdown: "b" },
          { url: "https://docs.example.com/c", markdown: "c" },
          { url: "https://other.example.com/d", markdown: "d" },
        ],
      },
    };
    const response = await request(
      appFor({ body, teamId: "preview_keyless_203.0.113.8" }),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(body);
  });

  it("does not suggest unavailable Interact on a self-hosted 401 scrape", async () => {
    config.USE_DB_AUTHENTICATION = false;
    const body = {
      success: true,
      data: { metadata: { statusCode: 401, scrapeId: "scrape-id" } },
    };
    const response = await request(appFor({ endpoint: "scrape", body }))
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(body);
  });

  it("does not add static feedback guidance to an otherwise hint-free result", async () => {
    const response = await request(appFor())
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body).not.toHaveProperty("agent_hints");
  });

  it("adds a low-credit notice without replacing result guidance", async () => {
    const body = {
      success: true,
      data: { web: [{ url: "https://example.com", description: "excerpt" }] },
    };
    const response = await request(appFor({ body, remainingCredits: 99 }))
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body.agent_hints).toHaveLength(2);
    expect(response.body.agent_hints[0]).toBe(
      "The connected Firecrawl account is low on credits. Let the user know they should add more credits.",
    );
    expect(response.body.agent_hints[1]).toContain("firecrawl_scrape");
  });

  it("does not add a credit notice at the threshold", async () => {
    const response = await request(appFor({ remainingCredits: 100 }))
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body).not.toHaveProperty("agent_hints");
  });

  it("preserves a failure envelope when no hint applies", async () => {
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

  it("adds only the low-credit notice to a failure envelope", async () => {
    const body = {
      success: false,
      error: "Bad URL",
      code: "BAD_REQUEST",
      details: [{ field: "url" }],
    };
    const response = await request(
      appFor({ body, status: 400, remainingCredits: 0 }),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject(body);
    expect(response.body.agent_hints).toEqual([
      "The connected Firecrawl account is low on credits. Let the user know they should add more credits.",
    ]);
  });
});
