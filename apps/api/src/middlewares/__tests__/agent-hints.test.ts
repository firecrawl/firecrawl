import express from "express";
import request from "supertest";
import { config } from "../../config";
import type { ProviderHintsHolder } from "../../lib/agent-hints-provider";
import {
  agentHintsMiddleware,
  agentHintsProviderMiddleware,
} from "../agent-hints";

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

const EXCERPT_BODY = {
  success: true,
  data: { web: [{ url: "https://example.com", description: "excerpt" }] },
};

function holderAppFor(holder: ProviderHintsHolder | undefined, body: object) {
  const app = express();
  app.use(express.json());
  app.post(
    "/",
    agentHintsMiddleware("search"),
    (req, res, next) => {
      (req as any).auth = { team_id: "account-team" };
      res.locals.agentHintsProvider = holder;
      next();
    },
    (_req, res) => {
      res.json(body);
    },
  );
  return app;
}

describe("agent hint response middleware with an external provider", () => {
  it("appends settled provider hints after deterministic hints", async () => {
    const response = await request(
      holderAppFor(
        { settled: true, hints: [{ id: "p1", text: "Provider hint." }] },
        EXCERPT_BODY,
      ),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body.agent_hints).toHaveLength(2);
    expect(response.body.agent_hints[0]).toContain("firecrawl_scrape");
    expect(response.body.agent_hints[1]).toBe("Provider hint.");
  });

  it("adds provider hints when no deterministic hint applies", async () => {
    const body = { success: true, data: {} };
    const response = await request(
      holderAppFor(
        { settled: true, hints: [{ id: "p1", text: "Provider hint." }] },
        body,
      ),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body).toEqual({ ...body, agent_hints: ["Provider hint."] });
  });

  it("ignores provider hints that have not arrived yet", async () => {
    const body = { success: true, data: {} };
    const response = await request(
      holderAppFor(
        { settled: false, hints: [{ id: "p1", text: "Provider hint." }] },
        body,
      ),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body).toEqual(body);
  });

  it("does not add provider hints to a failure envelope", async () => {
    const body = { success: false, error: "Bad URL", code: "BAD_REQUEST" };
    const response = await request(
      holderAppFor(
        { settled: true, hints: [{ id: "p1", text: "Provider hint." }] },
        body,
      ),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body).toEqual(body);
  });

  it("does not add provider hints without the opt-in header", async () => {
    const body = { success: true, data: {} };
    const response = await request(
      holderAppFor(
        { settled: true, hints: [{ id: "p1", text: "Provider hint." }] },
        body,
      ),
    )
      .post("/")
      .send({});
    expect(response.body).toEqual(body);
  });
});

describe("agent hints provider middleware", () => {
  const original = {
    url: config.AGENT_HINTS_PROVIDER_URL,
    timeout: config.AGENT_HINTS_PROVIDER_TIMEOUT_MS,
  };
  let teamCounter = 0;

  function providerAppFor(
    auth: { team_id: string; org_id?: string | null } | undefined,
    acuc?: { api_key: string; api_key_id: number },
  ) {
    const app = express();
    app.use(express.json());
    app.post(
      "/",
      agentHintsMiddleware("scrape"),
      (req, _res, next) => {
        (req as any).auth = auth;
        (req as any).acuc = acuc;
        next();
      },
      agentHintsProviderMiddleware("scrape"),
      (_req, res) => {
        res.json({ success: true, data: {} });
      },
    );
    return app;
  }

  function mockProvider(gate?: Promise<void>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await gate;
      return new Response(
        JSON.stringify({
          hints: [{ id: "p1", text: "Provider hint." }],
          ttl_seconds: 60,
        }),
        { status: 200 },
      );
    });
  }

  beforeEach(() => {
    config.AGENT_HINTS_PROVIDER_URL = "http://hints.invalid/v1/hints";
    config.AGENT_HINTS_PROVIDER_TIMEOUT_MS = 2000;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    config.AGENT_HINTS_PROVIDER_URL = original.url;
    config.AGENT_HINTS_PROVIDER_TIMEOUT_MS = original.timeout;
  });

  it("leaves the response unchanged when no provider is configured", async () => {
    config.AGENT_HINTS_PROVIDER_URL = undefined;
    const fetchSpy = mockProvider();
    const response = await request(
      providerAppFor({ team_id: `team-${++teamCounter}` }),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body).toEqual({ success: true, data: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call the provider without the opt-in header", async () => {
    const fetchSpy = mockProvider();
    await request(providerAppFor({ team_id: `team-${++teamCounter}` }))
      .post("/")
      .send({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call the provider without an authenticated team", async () => {
    const fetchSpy = mockProvider();
    await request(providerAppFor(undefined))
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the request context without the API key", async () => {
    const fetchSpy = mockProvider();
    const teamId = `team-${++teamCounter}`;
    await request(
      providerAppFor(
        { team_id: teamId, org_id: "org-1" },
        { api_key: "fc-secret-key", api_key_id: 7 },
      ),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .set("x-origin", "mcp")
      .send({});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = String(fetchSpy.mock.calls[0][1]?.body);
    expect(JSON.parse(body)).toEqual({
      version: 1,
      team_id: teamId,
      org_id: "org-1",
      api_key_id: 7,
      endpoint: "scrape",
      surface: "mcp",
      keyless: false,
    });
    expect(body).not.toContain("fc-secret-key");
  });

  it("does not send a keyless caller's team ID or IP", async () => {
    const fetchSpy = mockProvider();
    const ip = `192.0.2.${++teamCounter}`;
    await request(
      providerAppFor(
        { team_id: `preview_keyless_${ip}`, org_id: null },
        { api_key: "", api_key_id: 0 },
      ),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body.keyless).toBe(true);
    expect(body.team_id).toMatch(/^keyless_[0-9a-f]{64}$/);
    for (const value of Object.values(body)) {
      expect(String(value)).not.toContain(ip);
      expect(String(value)).not.toContain("preview_keyless_");
    }
  });

  it("does not wait for a pending provider and serves its hints from cache afterwards", async () => {
    let release!: () => void;
    const fetchSpy = mockProvider(
      new Promise<void>(resolve => (release = resolve)),
    );
    const app = providerAppFor({ team_id: `team-${++teamCounter}` });

    const first = await request(app)
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(first.body).toEqual({ success: true, data: {} });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(
      async () => {
        const second = await request(app)
          .post("/")
          .set("X-Firecrawl-Agent-Hints", "true")
          .send({});
        expect(second.body.agent_hints).toEqual(["Provider hint."]);
      },
      { timeout: 3000, interval: 50 },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
