/**
 * E2E tests for v2 crawl (translated from Python tests)
 */
import Firecrawl from "../../../index";
import { config } from "dotenv";
import { getIdentity, getApiUrl } from "./utils/idmux";
import { describe, test, expect, beforeAll } from "@jest/globals";

config();

const API_URL = getApiUrl();
let client: Firecrawl;

beforeAll(async () => {
  const { apiKey } = await getIdentity({ name: "js-e2e-crawl" });
  client = new Firecrawl({ apiKey, apiUrl: API_URL });
});

describe("v2.crawl e2e", () => {

  test("start crawl minimal request", async () => {
    if (!client) throw new Error();
    const job = await client.startCrawl("https://docs.firecrawl.dev", { limit: 3 });
    expect(typeof job.id).toBe("string");
    expect(typeof job.url).toBe("string");
  }, 90_000);

  test("start crawl with options", async () => {
    if (!client) throw new Error();
    const job = await client.startCrawl("https://docs.firecrawl.dev", { limit: 5, maxDiscoveryDepth: 2 });
    expect(typeof job.id).toBe("string");
    expect(typeof job.url).toBe("string");
  }, 90_000);

  test("start crawl with prompt", async () => {
    if (!client) throw new Error();
    const job = await client.startCrawl("https://firecrawl.dev", { prompt: "Extract all blog posts", limit: 3 });
    expect(typeof job.id).toBe("string");
    expect(typeof job.url).toBe("string");
  }, 90_000);

  test("get crawl status", async () => {
    if (!client) throw new Error();
    const start = await client.startCrawl("https://docs.firecrawl.dev", { limit: 3 });
    const status = await client.getCrawlStatus(start.id);
    expect(["scraping", "completed", "failed", "cancelled"]).toContain(status.status);
    expect(status.completed).toBeGreaterThanOrEqual(0);
    // Verify status includes id field
    expect(status.id).toBeDefined();
    expect(status.id).toBe(start.id);
    // next/expiresAt may be null/undefined depending on state; check shape
    expect(Array.isArray(status.data)).toBe(true);
  }, 120_000);

  test("cancel crawl", async () => {
    if (!client) throw new Error();
    const start = await client.startCrawl("https://docs.firecrawl.dev", { limit: 3 });
    const ok = await client.cancelCrawl(start.id);
    expect(ok).toBe(true);
  }, 120_000);

  test("get crawl errors", async () => {
    if (!client) throw new Error();
    const start = await client.startCrawl("https://docs.firecrawl.dev", { limit: 3 });
    const resp = await client.getCrawlErrors(start.id);
    expect(resp).toHaveProperty("errors");
    expect(resp).toHaveProperty("robotsBlocked");
    expect(Array.isArray(resp.errors)).toBe(true);
    expect(Array.isArray(resp.robotsBlocked)).toBe(true);
    for (const e of resp.errors) {
      expect(typeof e.id === "string" || e.id == null).toBe(true);
      expect(typeof e.timestamp === "string" || e.timestamp == null).toBe(true);
      expect(typeof e.url === "string" || e.url == null).toBe(true);
      expect(typeof e.error === "string" || e.error == null).toBe(true);
    }
  }, 120_000);

  test("get crawl errors with invalid id should throw", async () => {
    if (!client) throw new Error();
    await expect(client.getCrawlErrors("invalid-job-id-12345")).rejects.toThrow();
  }, 60_000);

  test("get active crawls", async () => {
    if (!client) throw new Error();
    const active = await client.getActiveCrawls();
    expect(typeof active.success).toBe("boolean");
    expect(Array.isArray(active.crawls)).toBe(true);
    for (const c of active.crawls) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.teamId).toBe("string");
      expect(typeof c.url).toBe("string");
      if (c.options != null) {
        expect(typeof c.options === "object").toBe(true);
      }
    }
  }, 90_000);

  test("get active crawls with running crawl", async () => {
    if (!client) throw new Error();
    const start = await client.startCrawl("https://docs.firecrawl.dev", { limit: 5 });
    await new Promise(resolve => setTimeout(resolve, 300));
    const active = await client.getActiveCrawls();
    expect(Array.isArray(active.crawls)).toBe(true);
    const ids = active.crawls.map(c => c.id);
    expect(ids.includes(start.id)).toBe(true);
    await client.cancelCrawl(start.id);
  }, 120_000);

  test("crawl with wait", async () => {
    if (!client) throw new Error();
    const job = await client.crawl("https://docs.firecrawl.dev", { limit: 3, maxDiscoveryDepth: 2, pollInterval: 1, timeout: 120 });
    expect(["completed", "failed"]).toContain(job.status);
    expect(job.completed).toBeGreaterThanOrEqual(0);
    expect(job.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(job.data)).toBe(true);
  }, 180_000);

  test("crawl with wait returns job id for error retrieval", async () => {
    if (!client) throw new Error();
    const job = await client.crawl("https://docs.firecrawl.dev", { limit: 3, maxDiscoveryDepth: 2, pollInterval: 1, timeout: 120 });
    // Verify job has id field
    expect(job.id).toBeDefined();
    expect(typeof job.id).toBe("string");
    // Verify we can use the id to retrieve errors
    const errors = await client.getCrawlErrors(job.id!);
    expect(errors).toHaveProperty("errors");
    expect(errors).toHaveProperty("robotsBlocked");
    expect(Array.isArray(errors.errors)).toBe(true);
    expect(Array.isArray(errors.robotsBlocked)).toBe(true);
  }, 180_000);

  test("crawl with prompt and wait", async () => {
    if (!client) throw new Error();
    const job = await client.crawl("https://docs.firecrawl.dev", { prompt: "Extract all blog posts", limit: 3, pollInterval: 1, timeout: 120 });
    expect(["completed", "failed"]).toContain(job.status);
    expect(job.completed).toBeGreaterThanOrEqual(0);
    expect(job.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(job.data)).toBe(true);
  }, 180_000);

  test("crawl with scrape options", async () => {
    if (!client) throw new Error();
    const job = await client.startCrawl("https://docs.firecrawl.dev", {
      limit: 2,
      scrapeOptions: { formats: ["markdown", "links"], onlyMainContent: false, mobile: true },
    });
    expect(typeof job.id).toBe("string");
  }, 120_000);

  test("crawl with json format object", async () => {
    if (!client) throw new Error();
    const job = await client.startCrawl("https://docs.firecrawl.dev", {
      limit: 2,
      scrapeOptions: { formats: [{ type: "json", prompt: "Extract page title", schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }] },
    });
    expect(typeof job.id).toBe("string");
  }, 120_000);

  test("crawl all parameters", async () => {
    if (!client) throw new Error();
    const job = await client.startCrawl("https://docs.firecrawl.dev", {
      prompt: "Extract all blog posts and documentation",
      includePaths: ["/blog/*", "/docs/*"],
      excludePaths: ["/admin/*"],
      maxDiscoveryDepth: 3,
      sitemap: "skip",
      ignoreQueryParameters: true,
      limit: 5,
      crawlEntireDomain: true,
      allowExternalLinks: false,
      allowSubdomains: true,
      delay: 1,
      maxConcurrency: 2,
      webhook: "https://example.com/hook",
      scrapeOptions: {
        formats: ["markdown", "html"],
        headers: { "User-Agent": "Test Bot" },
        includeTags: ["h1", "h2"],
        excludeTags: ["nav"],
        onlyMainContent: false,
        timeout: 15_000,
        waitFor: 2000,
        mobile: true,
        skipTlsVerification: true,
        removeBase64Images: false,
      },
      zeroDataRetention: false,
    });
    expect(typeof job.id).toBe("string");
  }, 180_000);

  test("crawl params preview", async () => {
    if (!client) throw new Error();
    const params = await client.crawlParamsPreview("https://docs.firecrawl.dev", "Extract all blog posts and documentation");
    expect(params && typeof params === "object").toBe(true);
    // Optional fields may or may not be present; just assert object shape
  }, 60_000);
});

