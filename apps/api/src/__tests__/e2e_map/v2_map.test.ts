import request from "supertest";
import dotenv from "dotenv";

dotenv.config();
const TEST_URL = "http://127.0.0.1:3002";

describe("E2E Tests for Map V2 API Routes", () => {
  it.concurrent(
    "should return web results with metadata in dictionary format",
    async () => {
      const response = await request(TEST_URL)
        .post("/v2/map")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          url: "https://roastmywebsite.ai",
          limit: 10,
        });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("success", true);
      expect(response.body).toHaveProperty("web");
      expect(Array.isArray(response.body.web)).toBe(true);

      if (response.body.web.length > 0) {
        const firstResult = response.body.web[0];
        expect(firstResult).toHaveProperty("url");
        expect(firstResult).toHaveProperty("title");
        expect(firstResult).toHaveProperty("description");
      }

      // Check metadata
      expect(response.body).toHaveProperty("metadata");
      expect(response.body.metadata).toHaveProperty("totalCount");
      expect(response.body.metadata).toHaveProperty("hasMore");

      // Check backwards compatibility
      expect(response.body).toHaveProperty("links");
      expect(Array.isArray(response.body.links)).toBe(true);
    },
    60000,
  );

  it.concurrent(
    "should handle sitemapOnly parameter (transformed to sitemap='only')",
    async () => {
      const response = await request(TEST_URL)
        .post("/v2/map")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          url: "https://firecrawl.dev",
          sitemapOnly: true,
          limit: 10,
        });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("success", true);
      expect(response.body).toHaveProperty("web");
      expect(Array.isArray(response.body.web)).toBe(true);
    },
    60000,
  );

  it.concurrent(
    "should handle ignoreSitemap parameter (transformed to sitemap='skip')",
    async () => {
      const response = await request(TEST_URL)
        .post("/v2/map")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          url: "https://firecrawl.dev",
          ignoreSitemap: true,
          limit: 10,
        });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("success", true);
      expect(response.body).toHaveProperty("web");
    },
    60000,
  );

  it.concurrent(
    "should work with search parameter and return relevant results",
    async () => {
      const response = await request(TEST_URL)
        .post("/v2/map")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          url: "https://firecrawl.dev",
          search: "pricing",
          limit: 5,
        });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("success", true);
      expect(response.body).toHaveProperty("web");
      expect(response.body).toHaveProperty("metadata");
      expect(response.body.metadata).toHaveProperty("searchQuery", "pricing");
    },
    60000,
  );

  it.concurrent(
    "should respect timeout parameter",
    async () => {
      const response = await request(TEST_URL)
        .post("/v2/map")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          url: "https://firecrawl.dev",
          timeout: 1, // 1ms timeout
        });

      expect(response.statusCode).toBe(408);
      expect(response.body).toHaveProperty("success", false);
      expect(response.body).toHaveProperty("error", "Map timed out");
    },
    10000,
  );
});
