import request from "supertest";
import { config } from "../../config";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";
const fs = require("fs");
const path = require("path");

const TEST_URL = "http://127.0.0.1:3002";

describe("E2E Tests for API Routes with No Authentication", () => {
  let originalConfig: Partial<typeof config>;

  // save original config values
  beforeAll(() => {
    originalConfig = {
      USE_DB_AUTHENTICATION: config.USE_DB_AUTHENTICATION,
      SUPABASE_ANON_TOKEN: config.SUPABASE_ANON_TOKEN,
      SUPABASE_URL: config.SUPABASE_URL,
      SUPABASE_SERVICE_TOKEN: config.SUPABASE_SERVICE_TOKEN,
      OPENAI_API_KEY: config.OPENAI_API_KEY,
      BULL_AUTH_KEY: config.BULL_AUTH_KEY,
      PLAYWRIGHT_MICROSERVICE_URL: config.PLAYWRIGHT_MICROSERVICE_URL,
      LLAMAPARSE_API_KEY: config.LLAMAPARSE_API_KEY,
      TEST_API_KEY: config.TEST_API_KEY,
    };
    config.USE_DB_AUTHENTICATION = false;
    config.SUPABASE_ANON_TOKEN = "";
    config.SUPABASE_URL = "";
    config.SUPABASE_SERVICE_TOKEN = "";
    config.OPENAI_API_KEY = "";
    config.BULL_AUTH_KEY = "";
    config.PLAYWRIGHT_MICROSERVICE_URL = "";
    config.LLAMAPARSE_API_KEY = "";
    config.TEST_API_KEY = "";
  });

  // restore original config values
  afterAll(() => {
    Object.assign(config, originalConfig);
  });

  describe("GET /e2e-test", () => {
    it.concurrent("should return OK message", async () => {
      const response = await request(TEST_URL).get("/e2e-test");
      expect(response.statusCode).toBe(200);
      expect(response.text).toContain("OK");
    });
  });

  describe("POST /v0/scrape", () => {
    it("should not require authorization", async () => {
      const response = await request(TEST_URL).post("/v0/scrape");
      expect(response.statusCode).not.toBe(401);
    });

    it("should return an error for a blocklisted URL without requiring authorization", async () => {
      const blocklistedUrl = "https://facebook.com/fake-test";
      const response = await request(TEST_URL)
        .post("/v0/scrape")
        .set("Content-Type", "application/json")
        .send({ url: blocklistedUrl });
      expect(response.statusCode).toBe(403);
      expect(response.body.error).toContain(BLOCKLISTED_URL_MESSAGE);
    });

    it("should return a successful response", async () => {
      const response = await request(TEST_URL)
        .post("/v0/scrape")
        .set("Content-Type", "application/json")
        .send({ url: "https://firecrawl.dev" });
      expect(response.statusCode).toBe(200);
    }, 10000); // 10 seconds timeout
  });

  describe("POST /v0/crawl", () => {
    it("should not require authorization", async () => {
      const response = await request(TEST_URL).post("/v0/crawl");
      expect(response.statusCode).not.toBe(401);
    });

    it("should return an error for a blocklisted URL", async () => {
      const blocklistedUrl = "https://twitter.com/fake-test";
      const response = await request(TEST_URL)
        .post("/v0/crawl")
        .set("Content-Type", "application/json")
        .send({ url: blocklistedUrl });
      expect(response.statusCode).toBe(403);
      expect(response.body.error).toContain(BLOCKLISTED_URL_MESSAGE);
    });

    it("should return a successful response", async () => {
      const response = await request(TEST_URL)
        .post("/v0/crawl")
        .set("Content-Type", "application/json")
        .send({ url: "https://firecrawl.dev" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("jobId");
      expect(response.body.jobId).toMatch(
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
      );
    });
  });

  describe("POST /v0/crawlWebsitePreview", () => {
    it("should not require authorization", async () => {
      const response = await request(TEST_URL).post("/v0/crawlWebsitePreview");
      expect(response.statusCode).not.toBe(401);
    });

    it("should return an error for a blocklisted URL", async () => {
      const blocklistedUrl = "https://instagram.com/fake-test";
      const response = await request(TEST_URL)
        .post("/v0/crawlWebsitePreview")
        .set("Content-Type", "application/json")
        .send({ url: blocklistedUrl });
      expect(response.statusCode).toBe(403);
      expect(response.body.error).toContain(BLOCKLISTED_URL_MESSAGE);
    });

    it("should return a successful response", async () => {
      const response = await request(TEST_URL)
        .post("/v0/crawlWebsitePreview")
        .set("Content-Type", "application/json")
        .send({ url: "https://firecrawl.dev" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("jobId");
      expect(response.body.jobId).toMatch(
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
      );
    });
  });

  describe("POST /v0/search", () => {
    it("should require not authorization", async () => {
      const response = await request(TEST_URL).post("/v0/search");
      expect(response.statusCode).not.toBe(401);
    });

    it("should return no error response with an invalid API key", async () => {
      const response = await request(TEST_URL)
        .post("/v0/search")
        .set("Authorization", `Bearer invalid-api-key`)
        .set("Content-Type", "application/json")
        .send({ query: "test" });
      expect(response.statusCode).not.toBe(401);
    });

    it("should return a successful response without a valid API key", async () => {
      const response = await request(TEST_URL)
        .post("/v0/search")
        .set("Content-Type", "application/json")
        .send({ query: "test" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("success");
      expect(response.body.success).toBe(true);
      expect(response.body).toHaveProperty("data");
    }, 20000);
  });

  describe("GET /v0/crawl/status/:jobId", () => {
    it("should not require authorization", async () => {
      const response = await request(TEST_URL).get("/v0/crawl/status/123");
      expect(response.statusCode).not.toBe(401);
    });

    it("should return Job not found for invalid job ID", async () => {
      const response = await request(TEST_URL).get(
        "/v0/crawl/status/invalidJobId",
      );
      expect(response.statusCode).toBe(404);
    });

    it("should return a successful response for a valid crawl job", async () => {
      const crawlResponse = await request(TEST_URL)
        .post("/v0/crawl")
        .set("Content-Type", "application/json")
        .send({ url: "https://firecrawl.dev" });
      expect(crawlResponse.statusCode).toBe(200);

      const response = await request(TEST_URL).get(
        `/v0/crawl/status/${crawlResponse.body.jobId}`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("status");
      expect(response.body.status).toBe("active");

      // wait for 30 seconds
      await new Promise(r => setTimeout(r, 30000));

      const completedResponse = await request(TEST_URL).get(
        `/v0/crawl/status/${crawlResponse.body.jobId}`,
      );
      expect(completedResponse.statusCode).toBe(200);
      expect(completedResponse.body).toHaveProperty("status");
      expect(completedResponse.body.status).toBe("completed");
      expect(completedResponse.body).toHaveProperty("data");
      expect(completedResponse.body.data[0]).toHaveProperty("content");
      expect(completedResponse.body.data[0]).toHaveProperty("markdown");
      expect(completedResponse.body.data[0]).toHaveProperty("metadata");
    }, 60000); // 60 seconds
  });

  describe("GET /is-production", () => {
    it("should return the production status", async () => {
      const response = await request(TEST_URL).get("/is-production");
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("isProduction");
    });
  });
});
