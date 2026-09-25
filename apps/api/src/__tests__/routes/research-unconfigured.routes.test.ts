import express from "express";
import request from "supertest";

vi.mock("@mendable/firecrawl-rs", () => ({
  validateRegexes: () => {},
  postProcessMarkdown: async (s: string) => s,
  transformHtml: async () => "",
  extractMetadata: () => ({}),
  extractLinks: () => [],
  extractImages: () => [],
  extractAttributes: () => [],
  getInnerJson: () => ({}),
  processPdf: async () => ({}),
  detectPdf: () => false,
  convertDocumentToMarkdown: async () => "",
  filterLinks: () => [],
  filterUrl: () => true,
}));

vi.mock("../../config", async importOriginal => {
  const mod = await importOriginal<typeof import("../../config")>();
  return {
    ...mod,
    config: { ...mod.config, RESEARCH_PROXY_URL: undefined },
  };
});

vi.mock("../../lib/research-upstream", () => ({
  fetchResearchUpstream: async () => null,
}));

vi.mock("../../services/logging/log_job", () => ({
  logRequest: async () => {},
  logResearchEndpoint: async () => {},
}));

vi.mock("../../lib/keyless", () => ({
  chargeKeylessCredits: async () => {},
}));

vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: async () => {},
}));

import { v2Router } from "../../routes/v2";
import { createResearchRouter } from "../../controllers/v2/research-proxy";

function appWithV2() {
  const app = express();
  app.use("/v2", v2Router);
  return app;
}

function appWithResearchRouter() {
  const app = express();
  app.use((req: any, _res, next) => {
    req.auth = { team_id: "team-test", plan: "standard" };
    req.acuc = { api_key_id: null };
    next();
  });
  app.use("/v2/search/research", createResearchRouter());
  return app;
}

const unconfigured = {
  success: false,
  error: "Research service is not configured",
};

describe("v2 research routes when RESEARCH_PROXY_URL is unset", () => {
  const app = appWithV2();

  it("answers paper search with 501 JSON instead of an unregistered 404", async () => {
    const res = await request(app).get(
      "/v2/search/research/papers?query=transformers",
    );

    expect(res.status).toBe(501);
    expect(res.type).toMatch(/json/);
    expect(res.body).toEqual(unconfigured);
  });

  it("answers paper inspect on the same unconfigured mount", async () => {
    const res = await request(app).get(
      "/v2/search/research/papers/1706.03762",
    );

    expect(res.status).toBe(501);
    expect(res.body).toEqual(unconfigured);
  });

  it("answers the legacy paper search mount the same way", async () => {
    const res = await request(app).get(
      "/v2/research/papers?query=transformers",
    );

    expect(res.status).toBe(501);
    expect(res.body).toEqual(unconfigured);
  });

  it("answers developer search with the same 501 JSON", async () => {
    const res = await request(app).get("/v2/search/developer?query=x");

    expect(res.status).toBe(501);
    expect(res.body).toEqual(unconfigured);
  });

  it("answers the pre-GA developer mount the same way", async () => {
    const res = await request(app).get("/v2/developer/search?query=x");

    expect(res.status).toBe(501);
    expect(res.body).toEqual(unconfigured);
  });
});

describe("createResearchRouter when the research backend is missing", () => {
  it("returns 501 JSON instead of an empty 404", async () => {
    const res = await request(appWithResearchRouter()).get(
      "/v2/search/research/papers?query=transformers",
    );

    expect(res.status).toBe(501);
    expect(res.type).toMatch(/json/);
    expect(res.body).toEqual(unconfigured);
  });
});
