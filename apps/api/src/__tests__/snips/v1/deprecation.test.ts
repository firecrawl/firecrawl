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

const LLMSTXT_LINK =
  '<https://docs.firecrawl.dev/migrating-from-llmstxt>; rel="deprecation"';
const DEEP_RESEARCH_DOCS_LINK =
  '<https://docs.firecrawl.dev/migrating-from-deep-research>; rel="deprecation"';

describe("Removed legacy endpoints", () => {
  it("POST /v1/llmstxt answers 410 without an API key", async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/llmstxt")
      .set("Content-Type", "application/json")
      .send({ url: "https://firecrawl.dev" });

    expect(res.statusCode).toBe(410);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("ENDPOINT_REMOVED");
    expect(res.body.error).toMatch(/llmstxt/i);
    expect(res.body.replacement).toBeUndefined();
    expect(res.headers["deprecation"]).toBe("@1778025600");
    expect(res.headers["link"]).toBe(LLMSTXT_LINK);
  }, 30000);

  it("GET /v1/llmstxt/:jobId answers 410", async () => {
    const res = await request(TEST_API_URL)
      .get(`/v1/llmstxt/${crypto.randomUUID()}`)
      .set("Authorization", `Bearer ${identity.apiKey}`);

    expect(res.statusCode).toBe(410);
    expect(res.body.code).toBe("ENDPOINT_REMOVED");
    expect(res.headers["deprecation"]).toBe("@1778025600");
    expect(res.headers["link"]).toBe(LLMSTXT_LINK);
  }, 30000);

  it("POST /v1/deep-research answers 410 with the successor-version Link", async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/deep-research")
      .set("Content-Type", "application/json")
      .send({ query: "what is firecrawl" });

    expect(res.statusCode).toBe(410);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("ENDPOINT_REMOVED");
    expect(res.body.error).toMatch(/deep-research/i);
    expect(res.body.replacement).toBe("/v2/agent");
    expect(res.headers["deprecation"]).toBe("@1778025600");
    expect(res.headers["link"]).toBe(
      `${DEEP_RESEARCH_DOCS_LINK}, </v2/agent>; rel="successor-version"`,
    );
  }, 30000);

  it("GET /v1/deep-research/:jobId answers 410", async () => {
    const res = await request(TEST_API_URL)
      .get(`/v1/deep-research/${crypto.randomUUID()}`)
      .set("Authorization", `Bearer ${identity.apiKey}`);

    expect(res.statusCode).toBe(410);
    expect(res.body.code).toBe("ENDPOINT_REMOVED");
    expect(res.headers["deprecation"]).toBe("@1778025600");
    expect(res.headers["link"]).toBe(
      `${DEEP_RESEARCH_DOCS_LINK}, </v2/agent/:jobId>; rel="successor-version"`,
    );
  }, 30000);
});

describe("Non-deprecated endpoints", () => {
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
