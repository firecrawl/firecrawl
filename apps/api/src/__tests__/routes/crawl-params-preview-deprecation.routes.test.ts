import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({ authed: true }));

// The real v2 router. Auth either answers 401 or lets the request through,
// the credit check passes, and the controller echoes the url without an LLM
// call, so the test sees exactly what the route's middleware adds.
vi.mock("../../routes/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("../../routes/shared")>();
  return {
    ...actual,
    authMiddleware: () => (req: any, res: any, next: any) => {
      if (!mocks.authed) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
      req.auth = { team_id: "team-1" };
      req.acuc = { flags: null };
      next();
    },
    checkCreditsMiddleware: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock("../../controllers/v2/crawl-params-preview", () => ({
  crawlParamsPreviewController: async (req: any, res: any) => {
    res.status(200).json({ success: true, data: { url: req.body.url } });
  },
}));

import { v2Router } from "../../routes/v2";

const app = express();
app.use(express.json());
app.use("/v2", v2Router);

const BODY = { url: "https://example.com", prompt: "only the blog" };

beforeEach(() => {
  mocks.authed = true;
});

describe("POST /v2/crawl/params-preview deprecation", () => {
  it("marks the response deprecated and points to POST /v2/crawl", async () => {
    const res = await request(app).post("/v2/crawl/params-preview").send(BODY);

    expect(res.status).toBe(200);
    expect(res.headers["deprecation"]).toBe("@1793923200");
    expect(res.headers["sunset"]).toBeUndefined();
    expect(res.headers["link"]).toBe('</v2/crawl>; rel="successor-version"');
    expect(res.headers["warning"]).toMatch(
      /^299 - "POST \/v2\/crawl\/params-preview is deprecated\./,
    );
    expect(res.body).toEqual({
      success: true,
      data: { url: BODY.url },
      warnings: [expect.stringContaining("POST /v2/crawl instead")],
      replacement: "/v2/crawl",
    });
  });

  it("runs after auth, so a rejected key gets a plain 401", async () => {
    mocks.authed = false;
    const res = await request(app).post("/v2/crawl/params-preview").send(BODY);

    expect(res.status).toBe(401);
    expect(res.headers["deprecation"]).toBeUndefined();
    expect(res.headers["warning"]).toBeUndefined();
    expect(res.body.warnings).toBeUndefined();
  });
});
