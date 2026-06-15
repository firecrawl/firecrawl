import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { TEST_API_URL } from "../lib";
import { idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "deprecation",
    concurrency: 10,
    credits: 1000,
  });
}, 10000);

describe("Deprecation warnings on legacy endpoints", () => {
  it("POST /v1/llmstxt enqueues with Deprecation header and warnings in body", async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/llmstxt")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({ url: "https://firecrawl.dev" });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers["deprecation"]).toBe("true");
    expect(res.headers["warning"]).toMatch(/^299 - "/);
    expect(res.headers["warning"]).toMatch(/llmstxt/i);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(res.body.warnings.some((w: string) => /llmstxt/i.test(w))).toBe(
      true,
    );
    expect(res.body.warnings.some((w: string) => /deprecated/i.test(w))).toBe(
      true,
    );
    expect(res.body.replacement).toBeUndefined();
    expect(res.headers["link"]).toBeUndefined();
  }, 30000);

  it("GET /v1/llmstxt/:jobId still emits warnings on 404", async () => {
    const res = await request(TEST_API_URL)
      .get(`/v1/llmstxt/${crypto.randomUUID()}`)
      .set("Authorization", `Bearer ${identity.apiKey}`);

    expect(res.statusCode).toBe(404);
    expect(res.headers["deprecation"]).toBe("true");
    expect(res.headers["warning"]).toMatch(/deprecated/i);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(res.body.warnings.some((w: string) => /deprecated/i.test(w))).toBe(
      true,
    );
  }, 30000);

  it("POST /v1/deep-research returns warnings and successor-version Link", async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/deep-research")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({
        query: "what is firecrawl",
        maxDepth: 1,
        maxUrls: 1,
        timeLimit: 60,
      });

    expect(res.statusCode).toBe(200);
    expect(res.headers["deprecation"]).toBe("true");
    expect(res.headers["warning"]).toMatch(/deep-research/i);
    expect(res.headers["link"]).toContain(
      '</v2/search>; rel="successor-version"',
    );
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(
      res.body.warnings.some((w: string) => /deep-research/i.test(w)),
    ).toBe(true);
    expect(res.body.replacement).toBe("/v2/search");
  }, 30000);

  it("non-deprecated endpoints do not emit Deprecation header or warnings", async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/scrape")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({ url: "https://firecrawl.dev" });

    expect(res.headers["deprecation"]).toBeUndefined();
    expect(res.headers["warning"]).toBeUndefined();
    if (res.body && typeof res.body === "object") {
      expect(res.body.warnings).toBeUndefined();
      expect(res.body.replacement).toBeUndefined();
    }
  }, 60000);
});
