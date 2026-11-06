import express from "express";
import request from "supertest";
import { createResearchRouter } from "../../controllers/v2/research-proxy";
import { v2Router } from "../../routes/v2";

const loggedRows: any[] = [];

// The real v2 router with the research proxy configured. Auth is stubbed to
// answer 401, so a 410 can only come from ahead of auth, rate limiting, the
// credit gate, the upstream call and billing.
vi.mock("../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    config: { ...actual.config, RESEARCH_PROXY_URL: "http://research.test" },
  };
});

vi.mock("../../routes/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("../../routes/shared")>();
  return {
    ...actual,
    authMiddleware: () => (_req: any, res: any) =>
      res.status(401).json({ success: false, error: "auth reached" }),
  };
});

// The paper routes run through the real research router against a stubbed
// upstream.
vi.mock("../../lib/research-upstream", () => ({
  fetchResearchUpstream: async () => ({
    status: 200,
    ok: true,
    headers: new Headers(),
    text: async () => JSON.stringify({ success: true, results: [] }),
  }),
}));

vi.mock("../../services/logging/log_job", () => ({
  logRequest: async () => {},
  logResearchEndpoint: async (row: any) => {
    loggedRows.push(row);
  },
}));

vi.mock("../../lib/keyless", () => ({
  chargeKeylessCredits: async () => {},
}));

// The limiter needs Redis, so here it admits every call.
vi.mock("../../lib/index-daily-limit", () => ({
  reserveIndexCalls: vi.fn(async () => ({ ok: true, release: async () => {} })),
  indexDailyLimitRefusal: vi.fn(),
}));

vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: async () => {},
}));

const app = express();
app.use("/v2", v2Router);

const canonical = express();
canonical.use((req: any, _res, next) => {
  req.auth = { team_id: "team-test", plan: "standard" };
  req.acuc = { api_key_id: null };
  next();
});
canonical.use("/v2/search/research", createResearchRouter());

describe.each([
  ["canonical", "/v2/search/research/github"],
  ["legacy", "/v2/research/github"],
])("removed github search, %s path", (_name, path) => {
  it("answers 410 with the developer index pointer before auth", async () => {
    const res = await request(app).get(
      `${path}?query=milvus+hybrid+search&k=3`,
    );

    expect(res.statusCode).toBe(410);
    expect(res.body).toEqual({
      success: false,
      code: "ENDPOINT_REMOVED",
      error: expect.stringContaining("/v2/search/developer"),
      detail: res.body.error,
      replacement: "/v2/search/developer",
      documentation_url: "https://docs.firecrawl.dev/features/developer",
    });
    expect(res.body.error).toContain("removed on 2026-11-03");
  });

  it("keeps the deprecation headers", async () => {
    const res = await request(app).get(path);

    expect(res.statusCode).toBe(410);
    expect(res.headers["deprecation"]).toBe("@1788393600");
    expect(res.headers["sunset"]).toBe("Tue, 03 Nov 2026 23:59:59 GMT");
    expect(res.headers["link"]).toContain(
      '<https://docs.firecrawl.dev/features/developer>; rel="deprecation"',
    );
    expect(res.headers["link"]).toContain(
      '</v2/search/developer>; rel="successor-version"',
    );
  });
});

it("leaves the paper routes on the same router alone", async () => {
  const res = await request(canonical).get(
    "/v2/search/research/papers?query=rag",
  );

  expect(res.statusCode).toBe(200);
  expect(res.headers["deprecation"]).toBeUndefined();
  expect(res.headers["sunset"]).toBeUndefined();
  expect(res.headers["link"]).toBeUndefined();
  expect(res.headers["warning"]).toBeUndefined();
  expect(res.body.warnings).toBeUndefined();
  expect(res.body.replacement).toBeUndefined();
  expect(loggedRows[0].response.warnings).toBeUndefined();
});
