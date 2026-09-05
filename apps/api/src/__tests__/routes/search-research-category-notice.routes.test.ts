import express from "express";
import request from "supertest";
import { researchCategoryNoticeMiddleware } from "../../controllers/v2/search";

// The snips cover the live route; this pins the shapes of `categories` the
// middleware must and must not react to, which need no search provider.
const app = express();
app.use(express.json());
app.post("/v2/search", researchCategoryNoticeMiddleware, (_req, res) => {
  res.status(200).json({ success: true, data: {}, creditsUsed: 0, id: "x" });
});

async function post(categories: unknown) {
  return request(app).post("/v2/search").send({ query: "x", categories });
}

describe("research category notice", () => {
  it("sets the header and the body warning, nothing else", async () => {
    const res = await post(["research"]);

    expect(res.statusCode).toBe(200);
    expect(res.headers["warning"]).toMatch(/^299 - "/);
    expect(res.headers["warning"]).toContain("2026-11-16");
    expect(res.headers["deprecation"]).toBeUndefined();
    expect(res.headers["sunset"]).toBeUndefined();
    expect(res.headers["link"]).toBeUndefined();
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toContain("data.research");
    expect(res.body.replacement).toBeUndefined();
  });

  it.each([
    [[{ type: "research" }]],
    [["research", "pdf"]],
    [["github", { type: "research" }]],
  ])("fires for %j", async categories => {
    const res = await post(categories);
    expect(res.body.warnings).toHaveLength(1);
  });

  it.each([
    [undefined],
    [[]],
    [["github"]],
    [["pdf"]],
    [["developer"]],
    ["research"],
    [[null, 7]],
  ])("stays silent for %j", async categories => {
    const res = await post(categories);
    expect(res.headers["warning"]).toBeUndefined();
    expect(res.body).not.toHaveProperty("warnings");
  });
});
