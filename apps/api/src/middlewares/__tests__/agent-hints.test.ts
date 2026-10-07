import express from "express";
import request from "supertest";
import { config } from "../../config";
import type { AgentHintRule } from "../../lib/agent-hint-rules";
import { evaluateAgentHintRules } from "../../lib/agent-hint-rules";
import { computeAgentHintSignals } from "../../lib/agent-hint-signals";
import {
  agentHintsProviderRequestsTotal,
  getProviderHints,
  type ProviderHintsHolder,
} from "../../lib/agent-hints-provider";
import {
  agentHintsMiddleware,
  agentHintsProviderMiddleware,
} from "../agent-hints";

vi.mock("../../lib/agent-hint-rules", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../lib/agent-hint-rules")>();
  return {
    ...actual,
    evaluateAgentHintRules: vi.fn(actual.evaluateAgentHintRules),
  };
});
vi.mock("../../lib/agent-hint-signals", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../lib/agent-hint-signals")>();
  return {
    ...actual,
    computeAgentHintSignals: vi.fn(actual.computeAgentHintSignals),
  };
});
vi.mock("../../lib/agent-hints-provider", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../lib/agent-hints-provider")>();
  return { ...actual, getProviderHints: vi.fn(actual.getProviderHints) };
});

async function evalErrors(): Promise<number> {
  const metric = await agentHintsProviderRequestsTotal.get();
  return metric.values.find(v => v.labels.outcome === "eval_error")?.value ?? 0;
}

const SUCCESS = { signal: "success", op: "eq" as const, value: true };
const TEST_RULES: AgentHintRule[] = [
  {
    id: "credits",
    when: [{ signal: "remaining_credits", op: "lt", value: 10 }],
    text: "Credits: {remaining_credits}.",
  },
  {
    id: "interact",
    group: "next",
    when: [
      SUCCESS,
      { signal: "page_status", op: "eq", value: 401 },
      { signal: "can_use_interact", op: "eq", value: true },
    ],
    text: "Interact: {scrape_id}.",
  },
  {
    id: "status",
    group: "next",
    when: [SUCCESS, { signal: "page_status", op: "gte", value: 400 }],
    text: "Status: {page_status}.",
  },
  {
    id: "excerpts",
    group: "next",
    when: [SUCCESS, { signal: "excerpt_count", op: "gt", value: 0 }],
    text: "Excerpts: {excerpt_results}.",
  },
  {
    id: "origin",
    group: "next",
    when: [
      SUCCESS,
      { signal: "can_use_map_and_crawl", op: "eq", value: true },
      { signal: "top_origin_count", op: "gte", value: 2 },
    ],
    text: "Origin: {top_origin}.",
  },
];

function appFor(
  {
    endpoint = "search",
    body = { success: true, data: {} },
    status = 200,
    remainingCredits,
    teamId = "account-team",
    rules = TEST_RULES,
  } = {} as any,
) {
  const app = express();
  app.use(express.json());
  app.post("/", agentHintsMiddleware(endpoint), (req, res) => {
    (req as any).auth = { team_id: teamId };
    res.locals.agentCreditsRemaining = remainingCredits;
    res.locals.agentHintsProvider = { settled: true, hints: [], rules };
    res.status(status).json(body);
  });
  return app;
}

const CLUSTERED_BODY = {
  success: true,
  data: {
    web: [
      { url: "https://docs.example.com/a", markdown: "a" },
      { url: "https://docs.example.com/b", markdown: "b" },
      { url: "https://other.example.com/c", markdown: "c" },
    ],
  },
};

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
    expect(response.body).toEqual({
      ...body,
      agent_hints: ['Excerpts: #1 "https://example.com/".'],
    });
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

  it("serves no hints without provider rules", async () => {
    const body = {
      success: true,
      data: { metadata: { statusCode: 404 } },
    };
    const response = await request(
      appFor({ endpoint: "scrape", body, remainingCredits: 0, rules: [] }),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body).toEqual(body);
  });

  it("passes the scrape page status and ID to the rules", async () => {
    const response = await request(
      appFor({
        endpoint: "scrape",
        body: {
          success: true,
          data: { metadata: { statusCode: 401, scrapeId: "scrape-id" } },
        },
      }),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body.agent_hints).toEqual(["Interact: scrape-id."]);
  });

  it("reports Interact as unavailable without database authentication", async () => {
    config.USE_DB_AUTHENTICATION = false;
    const response = await request(
      appFor({
        endpoint: "scrape",
        body: {
          success: true,
          data: { metadata: { statusCode: 401, scrapeId: "scrape-id" } },
        },
      }),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body.agent_hints).toEqual(["Status: 401."]);
  });

  it("reports Map and Crawl as available to account teams only", async () => {
    const account = await request(appFor({ body: CLUSTERED_BODY }))
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(account.body.agent_hints).toEqual([
      "Origin: https://docs.example.com.",
    ]);

    const keyless = await request(
      appFor({ body: CLUSTERED_BODY, teamId: "preview_keyless_203.0.113.8" }),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(keyless.statusCode).toBe(200);
    expect(keyless.body).toEqual(CLUSTERED_BODY);
  });

  it("does not add hints when no rule applies", async () => {
    const response = await request(appFor())
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body).not.toHaveProperty("agent_hints");
  });

  it("passes remaining credits to the rules alongside result guidance", async () => {
    const body = {
      success: true,
      data: { web: [{ url: "https://example.com", description: "excerpt" }] },
    };
    const response = await request(appFor({ body, remainingCredits: 9 }))
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body.agent_hints).toEqual([
      "Credits: 9.",
      'Excerpts: #1 "https://example.com/".',
    ]);
  });

  it("preserves a failure envelope when no rule applies", async () => {
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

  it("evaluates rules on a failure envelope", async () => {
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
    expect(response.body).toEqual({ ...body, agent_hints: ["Credits: 0."] });
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
  it("appends settled provider hints after rule hints", async () => {
    const response = await request(
      holderAppFor(
        {
          settled: true,
          hints: [{ id: "p1", text: "Provider hint." }],
          rules: TEST_RULES,
        },
        EXCERPT_BODY,
      ),
    )
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.body.agent_hints).toEqual([
      'Excerpts: #1 "https://example.com/".',
      "Provider hint.",
    ]);
  });

  it("adds provider hints when no rule applies", async () => {
    const body = { success: true, data: {} };
    const response = await request(
      holderAppFor(
        {
          settled: true,
          hints: [{ id: "p1", text: "Provider hint." }],
          rules: [],
        },
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
        {
          settled: false,
          hints: [{ id: "p1", text: "Provider hint." }],
          rules: [],
        },
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
        {
          settled: true,
          hints: [{ id: "p1", text: "Provider hint." }],
          rules: [],
        },
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
        {
          settled: true,
          hints: [{ id: "p1", text: "Provider hint." }],
          rules: [],
        },
        body,
      ),
    )
      .post("/")
      .send({});
    expect(response.body).toEqual(body);
  });
});

describe("agent hint failures never change the response", () => {
  const RULES = [
    {
      id: "results",
      when: [{ signal: "excerpt_count", op: "gt" as const, value: 0 }],
      text: "Rule: {excerpt_count}.",
    },
  ];
  const boom = () => {
    throw new Error("boom");
  };

  afterEach(() => {
    vi.mocked(evaluateAgentHintRules).mockClear();
  });

  it.each([
    [
      "the matcher",
      () => vi.mocked(evaluateAgentHintRules).mockImplementationOnce(boom),
      RULES,
    ],
    [
      "signal computation",
      () => vi.mocked(computeAgentHintSignals).mockImplementationOnce(boom),
      RULES,
    ],
  ])(
    "sends the original body with status 200 when %s throws",
    async (_name, arm, rules) => {
      arm();
      const before = await evalErrors();
      const response = await request(
        holderAppFor({ settled: true, hints: [], rules }, EXCERPT_BODY),
      )
        .post("/")
        .set("X-Firecrawl-Agent-Hints", "true")
        .send({});
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual(EXCERPT_BODY);
      expect(await evalErrors()).toBe(before + 1);
    },
  );

  it("still responds when the provider lookup cannot start", async () => {
    vi.mocked(getProviderHints).mockImplementationOnce(boom);
    const app = express();
    app.use(express.json());
    app.post(
      "/",
      agentHintsMiddleware("search"),
      (req, _res, next) => {
        (req as any).auth = { team_id: "account-team" };
        next();
      },
      agentHintsProviderMiddleware("search"),
      (_req, res) => {
        res.json(EXCERPT_BODY);
      },
    );
    const response = await request(app)
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(EXCERPT_BODY);
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

  it("serves no hints when the provider sends a malformed rule set", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            hints: [{ id: "p1", text: "Provider hint." }],
            rules: [
              { id: "ok", when: [], text: "Rule hint." },
              { id: "bad", when: [{ signal: "s", op: "nope" }], text: "x" },
            ],
            ttl_seconds: 60,
          }),
          { status: 200 },
        ),
    );
    const body = { success: true, data: { metadata: { statusCode: 404 } } };
    const app = express();
    app.use(express.json());
    app.post(
      "/",
      agentHintsMiddleware("scrape"),
      (req, _res, next) => {
        (req as any).auth = { team_id: `team-${++teamCounter}` };
        next();
      },
      agentHintsProviderMiddleware("scrape"),
      async (_req, res) => {
        await vi.waitFor(() =>
          expect(res.locals.agentHintsProvider?.settled).toBe(true),
        );
        res.json(body);
      },
    );
    const response = await request(app)
      .post("/")
      .set("X-Firecrawl-Agent-Hints", "true")
      .send({});
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(body);
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
      version: 2,
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
