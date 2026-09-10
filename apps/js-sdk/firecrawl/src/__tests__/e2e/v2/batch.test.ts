/**
 * E2E tests for v2 batch scrape (translated from Python tests)
 */
import Firecrawl from "../../../index";
import { config } from "dotenv";
import { getIdentity, getApiUrl } from "./utils/idmux";
import { testTimeoutMs, waitForJob, withRateLimitRetry } from "./utils/rateLimit";
import { describe, test, expect, beforeAll } from "@jest/globals";

config();

const API_URL = getApiUrl();
let client: Firecrawl;

beforeAll(async () => {
  const { apiKey } = await getIdentity({ name: "js-e2e-batch" });
  client = withRateLimitRetry(new Firecrawl({ apiKey, apiUrl: API_URL }));
});

describe("v2.batch e2e", () => {
  test("batch scrape minimal (wait)", async () => {
    const urls = [
      "https://docs.firecrawl.dev",
      "https://firecrawl.dev",
    ];
    const start = await client.startBatchScrape(urls, { options: { formats: ["markdown"] } });
    const job = await waitForJob(() => client.getBatchScrapeStatus(start.id), { pollInterval: 1, timeout: 210 });
    expect(["completed", "failed"]).toContain(job.status);
    expect(job.completed).toBeGreaterThanOrEqual(0);
    expect(job.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(job.data)).toBe(true);
  }, testTimeoutMs(362_000));

  test("batch scrape with wait returns job id for error retrieval", async () => {
    const urls = [
      "https://docs.firecrawl.dev",
      "https://firecrawl.dev",
    ];
    const start = await client.startBatchScrape(urls, { options: { formats: ["markdown"] } });
    const job = await waitForJob(() => client.getBatchScrapeStatus(start.id), { pollInterval: 1, timeout: 210 });
    // Verify job has id field
    expect(job.id).toBeDefined();
    expect(typeof job.id).toBe("string");
    // Verify we can use the id to retrieve errors
    const errors = await client.getBatchScrapeErrors(job.id!);
    expect(errors).toHaveProperty("errors");
    expect(errors).toHaveProperty("robotsBlocked");
    expect(Array.isArray(errors.errors)).toBe(true);
    expect(Array.isArray(errors.robotsBlocked)).toBe(true);
  }, testTimeoutMs(512_000));

  test("start batch minimal and status", async () => {
    const urls = ["https://docs.firecrawl.dev", "https://firecrawl.dev"]; 
    const start = await client.startBatchScrape(urls, { options: { formats: ["markdown"] }, ignoreInvalidURLs: true });
    expect(typeof start.id).toBe("string");
    expect(typeof start.url).toBe("string");
    const status = await client.getBatchScrapeStatus(start.id);
    expect(["scraping", "completed", "failed", "cancelled"]).toContain(status.status);
    expect(status.total).toBeGreaterThanOrEqual(0);
    // Verify status includes id field
    expect(status.id).toBeDefined();
    expect(status.id).toBe(start.id);
  }, testTimeoutMs(151_000));

  test("wait batch with all params", async () => {
    const urls = ["https://docs.firecrawl.dev", "https://firecrawl.dev"]; 
    const start = await client.startBatchScrape(urls, {
      options: {
        formats: [
          "markdown",
          { type: "json", prompt: "Extract page title", schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
          { type: "changeTracking", prompt: "Track changes", modes: ["json"] },
        ],
        onlyMainContent: true,
        mobile: false,
      },
      ignoreInvalidURLs: true,
      maxConcurrency: 2,
      zeroDataRetention: false,
    });
    const job = await waitForJob(() => client.getBatchScrapeStatus(start.id), { pollInterval: 1, timeout: 210 });
    expect(["completed", "failed", "cancelled"]).toContain(job.status);
    expect(job.completed).toBeGreaterThanOrEqual(0);
    expect(job.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(job.data)).toBe(true);
  }, testTimeoutMs(362_000));

  test("cancel batch", async () => {
    const urls = ["https://docs.firecrawl.dev", "https://firecrawl.dev"]; 
    const start = await client.startBatchScrape(urls, { options: { formats: ["markdown"] }, maxConcurrency: 1 });
    expect(typeof start.id).toBe("string");
    const cancelled = await client.cancelBatchScrape(start.id);
    expect(cancelled).toBe(true);
  }, testTimeoutMs(151_000));
});

