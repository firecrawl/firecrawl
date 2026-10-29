import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  auth: { team_id: "team-1" } as { team_id: string },
  acuc: undefined as { flags: Record<string, unknown> } | undefined,
}));

vi.mock("geoip-country", () => ({ lookup: mocks.lookup }));

vi.mock("../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      USE_DB_AUTHENTICATION: true,
      RESTRICTED_COUNTRIES: ["XX"],
    },
  };
});

// Real routers and country checks; auth is stubbed and the credit check ends
// the chain with a 204, so a 204 means the request got past the country check.
vi.mock("../../routes/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("../../routes/shared")>();
  return {
    ...actual,
    authMiddleware: () => (req: any, _res: any, next: any) => {
      req.auth = mocks.auth;
      req.acuc = mocks.acuc;
      next();
    },
    checkCreditsMiddleware: () => (_req: any, res: any) =>
      res.status(204).end(),
  };
});

import { config } from "../../config";
import { v2Router } from "../../routes/v2";

const app = express();
app.use(express.json());
app.use("/v2", v2Router);

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const ALWAYS_CHECKED: Array<[string, Record<string, unknown>]> = [
  ["/v2/agent", { prompt: "find the pricing page" }],
  ["/v2/agent", { prompt: "and now the docs", threadId: JOB_ID }],
  ["/v2/interact", {}],
  ["/v2/browser", {}],
  [`/v2/scrape/${JOB_ID}/interact`, { code: "console.log(1)" }],
  [`/v2/interact/${SESSION_ID}/execute`, { code: "console.log(1)" }],
  [`/v2/browser/${SESSION_ID}/execute`, { code: "console.log(1)" }],
];

function fromCountry(country: string) {
  mocks.lookup.mockReturnValue({ country });
}

beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.auth = { team_id: "team-1" };
  mocks.acuc = { flags: {} };
  config.USE_DB_AUTHENTICATION = true;
});

describe("country check on agent and browser routes", () => {
  for (const [path, body] of ALWAYS_CHECKED) {
    it(`rejects POST ${path} ${JSON.stringify(body)} from a restricted country`, async () => {
      fromCountry("XX");

      const res = await request(app).post(path).send(body);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain(
        "the agent, and browser/interact sessions is not allowed by default in your country",
      );
      expect(mocks.lookup).toHaveBeenCalled();
    });
  }

  it("lets agent and interact requests from other countries through", async () => {
    fromCountry("YY");

    expect(
      (await request(app).post("/v2/agent").send({ prompt: "x" })).status,
    ).toBe(204);
    expect((await request(app).post("/v2/interact").send({})).status).toBe(204);
    const interact = await request(app)
      .post("/v2/scrape/not-a-uuid/interact")
      .send({ code: "console.log(1)" });
    expect(interact.status).toBe(400);
    expect(interact.body.error).toContain("Invalid job ID format");
  });

  it("rejects keyless scrape interact without a team ACUC", async () => {
    fromCountry("XX");
    mocks.auth = { team_id: "preview_keyless_127.0.0.1" };
    mocks.acuc = undefined;

    const res = await request(app)
      .post(`/v2/scrape/${JOB_ID}/interact`)
      .send({ code: "console.log(1)" });

    expect(res.status).toBe(403);
  });

  it("honors the team's skipCountryCheck flag", async () => {
    fromCountry("XX");
    mocks.acuc = { flags: { skipCountryCheck: true } };

    expect(
      (await request(app).post("/v2/agent").send({ prompt: "x" })).status,
    ).toBe(204);
    expect((await request(app).post("/v2/browser").send({})).status).toBe(204);
  });

  it("points self-hosted deployments at their server configuration", async () => {
    fromCountry("XX");
    config.USE_DB_AUTHENTICATION = false;

    const res = await request(app).post("/v2/agent").send({ prompt: "x" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("check your server configuration");
  });

  it("uses the hosted contact copy otherwise", async () => {
    fromCountry("XX");

    const res = await request(app).post("/v2/agent").send({ prompt: "x" });

    expect(res.body.error).toContain("help@firecrawl.com");
  });
});

describe("country check on scrape-style routes", () => {
  it("lets a plain scrape from a restricted country through", async () => {
    fromCountry("XX");

    const res = await request(app)
      .post("/v2/scrape")
      .send({ url: "https://example.com" });

    expect(res.status).toBe(204);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("rejects a scrape with headers from a restricted country", async () => {
    fromCountry("XX");

    const res = await request(app)
      .post("/v2/scrape")
      .send({ url: "https://example.com", headers: { "x-test": "1" } });

    expect(res.status).toBe(403);
  });

  it("rejects a crawl with scrape actions from a restricted country", async () => {
    fromCountry("XX");

    const res = await request(app)
      .post("/v2/crawl")
      .send({
        url: "https://example.com",
        scrapeOptions: { actions: [{ type: "wait", milliseconds: 1 }] },
      });

    expect(res.status).toBe(403);
  });
});
