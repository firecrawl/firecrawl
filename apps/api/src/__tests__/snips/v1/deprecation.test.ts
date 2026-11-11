import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { itIf, TEST_API_URL } from "../lib";
import { sunsetOf } from "../../../lib/deprecations";
import {
  DEEP_RESEARCH_LIVE,
  idmux,
  Identity,
  LLMSTXT_LIVE,
  V1_LIVE,
} from "./lib";

const itV1 = itIf(V1_LIVE);
const itLlmsTxt = itIf(LLMSTXT_LIVE);
const itDeepResearch = itIf(DEEP_RESEARCH_LIVE);

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "deprecation",
    concurrency: 10,
    credits: 1000,
  });
}, 10000);

async function expectRemoved(
  key: Parameters<typeof sunsetOf>[0],
  method: "get" | "post",
  path: string,
  replacement: string | undefined,
  docs: string,
) {
  const res = await request(TEST_API_URL)
    [method](path)
    .set("Authorization", `Bearer ${identity.apiKey}`);

  expect(res.statusCode).toBe(410);
  expect(res.body.code).toBe("ENDPOINT_REMOVED");
  expect(res.body.replacement).toBe(replacement);
  expect(res.body.documentation_url).toBe(docs);
  expect(res.headers["sunset"]).toBe(new Date(sunsetOf(key)).toUTCString());
}

describe("Deprecation warnings on legacy endpoints", () => {
  itLlmsTxt(
    "POST /v1/llmstxt enqueues with Deprecation header and warnings in body",
    async () => {
      const res = await request(TEST_API_URL)
        .post("/v1/llmstxt")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("Content-Type", "application/json")
        .send({ url: "https://firecrawl.dev" });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.headers["deprecation"]).toBe("@1778025600");
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
      expect(res.headers["link"]).toBe(
        '<https://docs.firecrawl.dev/migrating-from-llmstxt>; rel="deprecation"',
      );
    },
    30000,
  );

  itLlmsTxt(
    "GET /v1/llmstxt/:jobId still emits warnings on 404",
    async () => {
      const res = await request(TEST_API_URL)
        .get(`/v1/llmstxt/${crypto.randomUUID()}`)
        .set("Authorization", `Bearer ${identity.apiKey}`);

      expect(res.statusCode).toBe(404);
      expect(res.headers["deprecation"]).toBe("@1778025600");
      expect(res.headers["warning"]).toMatch(/deprecated/i);
      expect(Array.isArray(res.body.warnings)).toBe(true);
      expect(res.body.warnings.some((w: string) => /deprecated/i.test(w))).toBe(
        true,
      );
    },
    30000,
  );

  itDeepResearch(
    "POST /v1/deep-research returns warnings and successor-version Link",
    async () => {
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
      expect(res.headers["deprecation"]).toBe("@1778025600");
      expect(res.headers["warning"]).toMatch(/deep-research/i);
      expect(res.headers["link"]).toBe(
        '<https://docs.firecrawl.dev/migrating-from-deep-research>; rel="deprecation", </v2/agent>; rel="successor-version"',
      );
      expect(Array.isArray(res.body.warnings)).toBe(true);
      expect(
        res.body.warnings.some((w: string) => /deep-research/i.test(w)),
      ).toBe(true);
      expect(res.body.replacement).toBe("/v2/agent");
    },
    30000,
  );

  itV1(
    "POST /v1/scrape points at /v2/scrape and the migration guide",
    async () => {
      const res = await request(TEST_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("Content-Type", "application/json")
        .send({ url: "https://firecrawl.dev" });

      expect(res.statusCode).toBe(200);
      expect(res.headers["deprecation"]).toBe("@1793923200");
      expect(res.headers["sunset"]).toBe("Thu, 10 Dec 2026 15:00:00 GMT");
      expect(res.headers["warning"]).toMatch(/\/v1\/scrape is deprecated/);
      expect(res.headers["link"]).toBe(
        '<https://docs.firecrawl.dev/migrate-to-v2>; rel="deprecation", </v2/scrape>; rel="successor-version"',
      );
      expect(
        res.body.warnings.some((w: string) => /\/v2\/scrape/.test(w)),
      ).toBe(true);
      expect(res.body.replacement).toBe("/v2/scrape");
    },
    60000,
  );

  itV1(
    "GET /v1/team/credit-usage points at its v2 route",
    async () => {
      const res = await request(TEST_API_URL)
        .get("/v1/team/credit-usage")
        .set("Authorization", `Bearer ${identity.apiKey}`);

      // Self-hosted has no billing client, so the status varies; the notice must not.
      expect(res.headers["deprecation"]).toBe("@1793923200");
      expect(res.headers["link"]).toContain(
        '</v2/team/credit-usage>; rel="successor-version"',
      );
      expect(res.body.replacement).toBe("/v2/team/credit-usage");
    },
    30000,
  );

  itV1(
    "GET /v1/concurrency-check points at its v2 route",
    async () => {
      const res = await request(TEST_API_URL)
        .get("/v1/concurrency-check")
        .set("Authorization", `Bearer ${identity.apiKey}`);

      expect(res.statusCode).toBe(200);
      expect(res.headers["deprecation"]).toBe("@1793923200");
      expect(res.headers["link"]).toContain(
        '</v2/concurrency-check>; rel="successor-version"',
      );
      expect(res.body.replacement).toBe("/v2/concurrency-check");
    },
    30000,
  );

  itIf(!V1_LIVE).each([
    ["post", "/v1/scrape", "/v2/scrape"],
    ["get", "/v1/team/credit-usage", "/v2/team/credit-usage"],
    ["get", "/v1/concurrency-check", "/v2/concurrency-check"],
  ] as const)(
    "%s %s answers 410 after the v1 sunset",
    async (method, path, replacement) => {
      const res = await request(TEST_API_URL)
        [method](path)
        .set("Authorization", `Bearer ${identity.apiKey}`);

      expect(res.statusCode).toBe(410);
      expect(res.body.code).toBe("ENDPOINT_REMOVED");
      expect(res.body.replacement).toBe(replacement);
      expect(res.body.documentation_url).toBe(
        "https://docs.firecrawl.dev/migrate-to-v2",
      );
      expect(res.headers["sunset"]).toBe("Thu, 10 Dec 2026 15:00:00 GMT");
    },
    30000,
  );

  itIf(!DEEP_RESEARCH_LIVE).each([
    ["v1_deep_research", "post", "/v1/deep-research", "/v2/agent"],
    [
      "v1_deep_research_status",
      "get",
      `/v1/deep-research/${crypto.randomUUID()}`,
      "/v2/agent/:jobId",
    ],
  ] as const)(
    "%s: %s %s answers 410 after the deep research sunset",
    async (key, method, path, replacement) => {
      await expectRemoved(
        key,
        method,
        path,
        replacement,
        "https://docs.firecrawl.dev/migrating-from-deep-research",
      );
    },
    30000,
  );

  itIf(!LLMSTXT_LIVE).each([
    ["v1_llmstxt", "post", "/v1/llmstxt"],
    ["v1_llmstxt_status", "get", `/v1/llmstxt/${crypto.randomUUID()}`],
  ] as const)(
    "%s: %s %s answers 410 after the llms.txt sunset",
    async (key, method, path) => {
      await expectRemoved(
        key,
        method,
        path,
        undefined,
        "https://docs.firecrawl.dev/migrating-from-llmstxt",
      );
    },
    30000,
  );

  it("non-deprecated endpoints do not emit Deprecation header or warnings", async () => {
    const res = await request(TEST_API_URL)
      .get("/v2/team/credit-usage")
      .set("Authorization", `Bearer ${identity.apiKey}`);

    expect(res.headers["deprecation"]).toBeUndefined();
    expect(res.headers["warning"]).toBeUndefined();
    if (res.body && typeof res.body === "object") {
      expect(res.body.warnings).toBeUndefined();
      expect(res.body.replacement).toBeUndefined();
    }
  }, 60000);
});
