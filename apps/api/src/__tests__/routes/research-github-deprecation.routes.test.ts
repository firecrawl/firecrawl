import express from "express";
import request from "supertest";

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

import { v2Router } from "../../routes/v2";

const app = express();
app.use("/v2", v2Router);

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
    expect(res.body.error).toContain("removed after 2026-11-03");
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

it("leaves the paper routes on the same mount behind auth", async () => {
  const res = await request(app).get("/v2/search/research/papers?query=rag");

  expect(res.statusCode).toBe(401);
  expect(res.headers["deprecation"]).toBeUndefined();
});
