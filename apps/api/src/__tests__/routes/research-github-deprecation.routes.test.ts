import express from "express";
import request from "supertest";
import { createResearchRouter } from "../../controllers/v2/research-proxy";

// Mounts the real research router against a stubbed upstream, so the
// deprecation contract is exercised through the actual controller rather than
// a fake. The one thing only this test can reach is the logged payload: on the
// canonical mount the controller responds with the same object it later writes
// to Postgres, so a mutating res.json would leak the notice into the
// research_github_searches row.
const upstreamCalls: string[] = [];
const loggedRows: any[] = [];

let upstreamBody: any = {
  success: true,
  results: [
    {
      resultType: "github_history",
      repo: "milvus-io/milvus",
      url: "https://github.com/milvus-io/milvus/issues/1",
      pageType: "issue",
      number: 1,
      snippet: "hybrid search",
      contentMd: "# hybrid search",
      segmentCount: 2,
      scores: { rrf: 0.5 },
    },
  ],
};
let upstreamStatus = 200;

vi.mock("../../lib/research-upstream", () => ({
  fetchResearchUpstream: async (options: { path: string }) => {
    upstreamCalls.push(options.path);
    return {
      status: upstreamStatus,
      ok: upstreamStatus >= 200 && upstreamStatus < 300,
      headers: new Headers(),
      text: async () => JSON.stringify(upstreamBody),
    };
  },
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

vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: async () => {},
}));

function appWith(legacy: boolean) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.auth = { team_id: "team-test", plan: "standard" };
    req.acuc = { api_key_id: null };
    next();
  });
  app.use(
    legacy ? "/v2/research" : "/v2/search/research",
    createResearchRouter(legacy ? { legacy: true } : {}),
  );
  return app;
}

const canonical = appWith(false);
const legacy = appWith(true);

beforeEach(() => {
  upstreamCalls.length = 0;
  loggedRows.length = 0;
  upstreamStatus = 200;
});

describe("github search deprecation, canonical mount", () => {
  it("sets every deprecation header", async () => {
    const res = await request(canonical).get(
      "/v2/search/research/github?query=milvus+hybrid+search&k=3",
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["deprecation"]).toBe("@1788393600");
    expect(res.headers["sunset"]).toBe("Tue, 03 Nov 2026 23:59:59 GMT");
    expect(res.headers["link"]).toContain(
      '<https://docs.firecrawl.dev/features/developer>; rel="deprecation"',
    );
    expect(res.headers["link"]).toContain(
      '</v2/search/developer>; rel="successor-version"',
    );
    expect(res.headers["warning"]).toMatch(/^299 - "/);
    expect(res.headers["warning"]).toContain("2026-11-03");
  });

  it("adds warnings and replacement to the body without losing the results", async () => {
    const res = await request(canonical).get(
      "/v2/search/research/github?query=x",
    );

    expect(res.body.success).toBe(true);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].repo).toBe("milvus-io/milvus");
    expect(res.body.replacement).toBe("/v2/search/developer");
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toContain("/v2/search/developer");
    expect(res.body.warnings[0]).toContain("2026-11-03");
  });

  it("keeps the deprecation notice out of the logged row", async () => {
    await request(canonical).get("/v2/search/research/github?query=x");

    expect(loggedRows).toHaveLength(1);
    const logged = loggedRows[0].response;
    expect(logged.success).toBe(true);
    expect(logged.results).toHaveLength(1);
    expect(logged.warnings).toBeUndefined();
    expect(logged.replacement).toBeUndefined();
    expect(JSON.stringify(logged)).not.toContain("deprecated");
  });

  it("still proxies to the unchanged upstream path", async () => {
    await request(canonical).get("/v2/search/research/github?query=x");

    expect(upstreamCalls).toEqual(["/v2/research/github"]);
  });

  it("warns on a rejected request too", async () => {
    const res = await request(canonical).get("/v2/search/research/github");

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.headers["deprecation"]).toBe("@1788393600");
    expect(res.body.warnings).toHaveLength(1);
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
});

describe("github search deprecation, legacy mount", () => {
  it("keeps the snake_case aliases alongside the notice", async () => {
    const res = await request(legacy).get("/v2/research/github?query=x");

    expect(res.statusCode).toBe(200);
    expect(res.headers["deprecation"]).toBe("@1788393600");
    expect(res.body.results[0].result_type).toBe("github_history");
    expect(res.body.results[0].page_type).toBe("issue");
    expect(res.body.results[0].content_md).toBe("# hybrid search");
    expect(res.body.results[0].segment_count).toBe(2);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.replacement).toBe("/v2/search/developer");
  });

  it("does not grow a snake_case twin of the injected keys", async () => {
    const res = await request(legacy).get("/v2/research/github?query=x");

    expect(res.body).not.toHaveProperty("warnings_");
    expect(res.body).not.toHaveProperty("replacement_");
  });

  it("keeps the notice out of the logged row here as well", async () => {
    await request(legacy).get("/v2/research/github?query=x");

    expect(loggedRows[0].response.warnings).toBeUndefined();
    expect(loggedRows[0].response.replacement).toBeUndefined();
  });
});
