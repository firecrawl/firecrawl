import express from "express";
import request from "supertest";
import { mountUnconfiguredResearchRoutes } from "../../controllers/v2/research-unavailable";

function appWithoutResearchProxy() {
  const app = express();
  const v2 = express.Router();
  mountUnconfiguredResearchRoutes(v2);
  app.use("/v2", v2);
  return app;
}

describe("research routes when RESEARCH_PROXY_URL is unset", () => {
  const app = appWithoutResearchProxy();

  it("answers paper search with 501 JSON instead of an unregistered 404", async () => {
    const res = await request(app).get(
      "/v2/search/research/papers?query=transformers",
    );

    expect(res.status).toBe(501);
    expect(res.type).toMatch(/json/);
    expect(res.body).toEqual({
      success: false,
      error: "Research service is not configured",
    });
  });

  it("answers paper inspect on the same unconfigured mount", async () => {
    const res = await request(app).get(
      "/v2/search/research/papers/1706.03762",
    );

    expect(res.status).toBe(501);
    expect(res.body).toEqual({
      success: false,
      error: "Research service is not configured",
    });
  });

  it("answers the legacy paper search mount the same way", async () => {
    const res = await request(app).get(
      "/v2/research/papers?query=transformers",
    );

    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Research service is not configured");
  });

  it("does not claim developer search is missing the research index", async () => {
    const res = await request(app).get("/v2/search/developer?query=x");

    expect(res.status).toBe(404);
    expect(res.body.error).not.toBe("Research service is not configured");
  });
});
