import express from "express";
import request from "supertest";
import { applyNotice, RESEARCH_CATEGORY_NOTICE } from "../../lib/deprecations";
import { hasCategory } from "../../lib/search-query-builder";

// The search controller needs the whole search pipeline behind it, so the
// notice contract is pinned here through the same two calls the controller
// makes: hasCategory to decide, applyNotice to annotate.
const body = {
  success: true,
  data: {
    web: [
      {
        url: "https://arxiv.org/abs/2104.05740",
        title: "SPLADE",
        description: "sparse retrieval",
        position: 1,
        category: "research",
      },
    ],
  },
  creditsUsed: 2,
  id: "0199-test",
};

const app = express();
app.use(express.json());
app.post("/v2/search", (req, res) => {
  if (hasCategory(req.body.categories, "research")) {
    applyNotice(res, RESEARCH_CATEGORY_NOTICE);
  }
  res.status(200).json(body);
});

describe("research category notice", () => {
  it("adds the headers and the body warning, keeps the results", async () => {
    const res = await request(app)
      .post("/v2/search")
      .send({ query: "splade", categories: ["research"] });

    expect(res.statusCode).toBe(200);
    expect(res.headers["warning"]).toMatch(/^299 - "/);
    expect(res.headers["warning"]).toContain("2026-11-16");
    expect(res.headers["link"]).toBe(
      '<https://docs.firecrawl.dev/features/research>; rel="deprecation"',
    );
    expect(res.headers["deprecation"]).toBeUndefined();
    expect(res.headers["sunset"]).toBeUndefined();

    expect(res.body.data.web).toHaveLength(1);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toContain("data.research");
    expect(res.body.warnings[0]).toContain("includeDomains");
    expect(res.body.replacement).toBeUndefined();
    expect(body).not.toHaveProperty("warnings");
  });

  it("fires for the object form and for combinations", async () => {
    for (const categories of [
      [{ type: "research" }],
      ["research", "pdf"],
      ["github", { type: "research" }],
    ]) {
      const res = await request(app)
        .post("/v2/search")
        .send({ query: "x", categories });
      expect(res.body.warnings).toHaveLength(1);
    }
  });

  it("leaves every other request alone", async () => {
    for (const categories of [
      undefined,
      [],
      ["github"],
      ["pdf", "developer"],
    ]) {
      const res = await request(app)
        .post("/v2/search")
        .send({ query: "x", categories });
      expect(res.headers["warning"]).toBeUndefined();
      expect(res.headers["link"]).toBeUndefined();
      expect(res.body).not.toHaveProperty("warnings");
    }
  });
});
