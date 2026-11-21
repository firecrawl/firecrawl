import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { DEEP_RESEARCH_LIVE, deepResearch, idmux, Identity } from "./lib";
import { describeIf, HAS_AI, TEST_API_URL, TEST_PRODUCTION } from "../lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "deep-research",
    concurrency: 100,
    tokens: 1000000,
  });
}, 10000);

const describeDeepResearch = describeIf(
  (TEST_PRODUCTION || HAS_AI) && DEEP_RESEARCH_LIVE,
);

describeDeepResearch("Deep Research", () => {
  it("successfully completes a basic research query", async () => {
    const query = "What is artificial intelligence?";

    try {
      const result = await deepResearch(
        {
          query: query,
          maxDepth: 2,
          maxUrls: 3,
          timeLimit: 300, // 5 minutes in seconds
        },
        identity,
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.data).toBeDefined();
      expect(typeof result.data.finalAnalysis).toBe("string");
      expect(result.data.finalAnalysis.length).toBeGreaterThan(0);
      expect(Array.isArray(result.data.sources)).toBe(true);
      expect(result.data.sources.length).toBeGreaterThan(0);
      expect(Array.isArray(result.data.activities)).toBe(true);
      expect(result.data.activities.length).toBeGreaterThan(0);
    } catch (error) {
      console.error("Deep research test failed with error:", error);
      throw error;
    }
  }, 300000); // 5 minutes timeout to account for processing time
});

describeIf(TEST_PRODUCTION && DEEP_RESEARCH_LIVE)(
  "Deep Research with zero data retention",
  () => {
    it("completes for a team that forces zero data retention on search", async () => {
      const searchZdr = await idmux({
        name: "deep-research/search-zdr",
        concurrency: 100,
        tokens: 1000000,
        flags: { searchZDR: "forced-zdr" },
      });

      const result = await deepResearch(
        {
          query: "What is artificial intelligence?",
          maxDepth: 1,
          maxUrls: 3,
          timeLimit: 300,
        },
        searchZdr,
      );

      expect(Array.isArray(result.data.sources)).toBe(true);
      expect(result.data.sources.length).toBeGreaterThan(0);
    }, 300000);

    it("still refuses a team that forces zero data retention on scrape", async () => {
      const scrapeZdr = await idmux({
        name: "deep-research/scrape-zdr",
        concurrency: 100,
        tokens: 1000000,
        flags: { scrapeZDR: "forced" },
      });

      const res = await request(TEST_API_URL)
        .post("/v1/deep-research")
        .set("Authorization", `Bearer ${scrapeZdr.apiKey}`)
        .set("Content-Type", "application/json")
        .send({ query: "What is artificial intelligence?" });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("zero data retention");
    }, 30000);
  },
);
