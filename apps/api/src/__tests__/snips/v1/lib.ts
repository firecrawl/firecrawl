import { config } from "../../../config";
import {
  ScrapeRequestInput,
  Document,
  ExtractRequestInput,
  ExtractResponse,
  CrawlRequestInput,
  MapRequestInput,
  BatchScrapeRequestInput,
  SearchRequestInput,
  CrawlStatusResponse,
  CrawlResponse,
  OngoingCrawlsResponse,
  ErrorResponse,
  CrawlErrorsResponse,
} from "../../../controllers/v1/types";
import request from "supertest";
import {
  TEST_API_URL,
  scrapeTimeout,
  indexCooldown,
  Identity,
  idmux,
} from "../lib";

// Re-export shared utilities for backwards compatibility
export { scrapeTimeout, indexCooldown, Identity, idmux };

const pollSleep = async () => new Promise(r => setTimeout(r, 50));

export async function scrapeRaw(body: ScrapeRequestInput, identity: Identity) {
  return await request(TEST_API_URL)
    .post("/v1/scrape")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

function expectScrapeToSucceed(
  response: Awaited<ReturnType<typeof scrapeRaw>>,
) {
  if (response.statusCode !== 200) {
    console.warn(
      "Scrape did not succeed",
      JSON.stringify(response.body, null, 2),
    );
  }

  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(typeof response.body.data).toBe("object");
}

function expectScrapeToFail(response: Awaited<ReturnType<typeof scrapeRaw>>) {
  expect(response.statusCode).not.toBe(200);
  expect(response.body.success).toBe(false);
  expect(typeof response.body.error).toBe("string");
}

export async function scrape(
  body: ScrapeRequestInput,
  identity: Identity,
): Promise<Document> {
  const raw = await scrapeRaw(body, identity);
  expectScrapeToSucceed(raw);
  if (body.proxy === "stealth") {
    expect(raw.body.data.metadata.proxyUsed).toBe("stealth");
  } else if (!body.proxy || body.proxy === "basic") {
    expect(raw.body.data.metadata.proxyUsed).toBe("basic");
  }
  return raw.body.data;
}

export async function scrapeWithFailure(
  body: ScrapeRequestInput,
  identity: Identity,
): Promise<{
  success: false;
  error: string;
}> {
  const raw = await scrapeRaw(body, identity);
  expectScrapeToFail(raw);
  return raw.body;
}

export async function scrapeStatusRaw(jobId: string, identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v1/scrape/" + encodeURIComponent(jobId))
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

export async function scrapeStatus(
  jobId: string,
  identity: Identity,
): Promise<Document> {
  const raw = await scrapeStatusRaw(jobId, identity);
  expect(raw.statusCode).toBe(200);
  expect(raw.body.success).toBe(true);
  expect(typeof raw.body.data).toBe("object");
  expect(raw.body.data).not.toBeNull();
  expect(raw.body.data).toBeDefined();
  return raw.body.data;
}

// =========================================
// Crawl API
// =========================================

export async function crawlStart(body: CrawlRequestInput, identity: Identity) {
  return await request(TEST_API_URL)
    .post("/v1/crawl")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

async function crawlStatus(id: string, identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v1/crawl/" + encodeURIComponent(id))
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

async function crawlOngoingRaw(identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v1/crawl/ongoing")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

export async function crawlOngoing(
  identity: Identity,
): Promise<Exclude<OngoingCrawlsResponse, ErrorResponse>> {
  const res = await crawlOngoingRaw(identity);
  expect(res.statusCode).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body;
}

function expectCrawlStartToSucceed(
  response: Awaited<ReturnType<typeof crawlStart>>,
) {
  if (response.statusCode !== 200) {
    console.warn(
      "Crawl start did not succeed",
      JSON.stringify(response.body, null, 2),
    );
  }

  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(typeof response.body.id).toBe("string");
}

function expectCrawlToSucceed(
  response: Awaited<ReturnType<typeof crawlStatus>>,
) {
  if (
    response.statusCode !== 200 ||
    response.body.success !== true ||
    response.body.status !== "completed"
  ) {
    console.warn(
      "Crawl did not succeed",
      JSON.stringify(response.body, null, 2),
    );
  }

  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(typeof response.body.status).toBe("string");
  expect(response.body.status).toBe("completed");
  expect(response.body).toHaveProperty("data");
  expect(Array.isArray(response.body.data)).toBe(true);
  expect(response.body.data.length).toBeGreaterThan(0);
}

export async function asyncCrawl(
  body: CrawlRequestInput,
  identity: Identity,
): Promise<Exclude<CrawlResponse, ErrorResponse>> {
  const cs = await crawlStart(body, identity);
  expectCrawlStartToSucceed(cs);
  return cs.body;
}

export async function asyncCrawlWaitForFinish(
  id: string,
  identity: Identity,
): Promise<Exclude<CrawlStatusResponse, ErrorResponse>> {
  let x: Awaited<ReturnType<typeof crawlStatus>> | undefined;

  do {
    if (x) await pollSleep();
    x = await crawlStatus(id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
  } while (x.body.status === "scraping");

  expectCrawlToSucceed(x);
  return x.body;
}

async function crawlErrors(
  id: string,
  identity: Identity,
): Promise<Exclude<CrawlErrorsResponse, ErrorResponse>> {
  const res = await request(TEST_API_URL)
    .get("/v1/crawl/" + id + "/errors")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();

  expect(res.statusCode).toBe(200);
  expect(res.body.success).not.toBe(false);

  return res.body;
}

export async function crawl(
  body: CrawlRequestInput,
  identity: Identity,
): Promise<Exclude<CrawlStatusResponse & { id: string }, ErrorResponse>> {
  const cs = await crawlStart(body, identity);
  expectCrawlStartToSucceed(cs);

  let x: Awaited<ReturnType<typeof crawlStatus>> | undefined;

  do {
    if (x) await pollSleep();
    x = await crawlStatus(cs.body.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
  } while (x.body.status === "scraping");

  const errors = await crawlErrors(cs.body.id, identity);
  if (errors.errors.length > 0) {
    console.warn("Crawl ", cs.body.id, " had errors:", errors.errors);
  }

  expectCrawlToSucceed(x);
  return {
    ...x.body,
    id: cs.body.id,
  };
}

// =========================================
// Batch Scrape API
// =========================================

async function batchScrapeStart(
  body: BatchScrapeRequestInput,
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v1/batch/scrape")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

async function batchScrapeStatus(id: string, identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v1/batch/scrape/" + encodeURIComponent(id))
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

function expectBatchScrapeStartToSucceed(
  response: Awaited<ReturnType<typeof batchScrapeStart>>,
) {
  if (response.statusCode !== 200) {
    console.warn(
      "Batch scrape start did not succeed",
      JSON.stringify(response.body, null, 2),
    );
  }
  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(typeof response.body.id).toBe("string");
}

function expectBatchScrapeToSucceed(
  response: Awaited<ReturnType<typeof batchScrapeStatus>>,
) {
  if (
    response.statusCode !== 200 ||
    response.body.success !== true ||
    response.body.status !== "completed"
  ) {
    console.warn(
      "Batch scrape did not succeed",
      JSON.stringify(response.body, null, 2),
    );
  }
  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(typeof response.body.status).toBe("string");
  expect(response.body.status).toBe("completed");
  expect(response.body).toHaveProperty("data");
  expect(Array.isArray(response.body.data)).toBe(true);
  expect(response.body.data.length).toBeGreaterThan(0);
}

export async function batchScrape(
  body: BatchScrapeRequestInput,
  identity: Identity,
): Promise<Exclude<CrawlStatusResponse, ErrorResponse> & { id: string }> {
  const bss = await batchScrapeStart(body, identity);
  expectBatchScrapeStartToSucceed(bss);

  let x: Awaited<ReturnType<typeof batchScrapeStatus>> | undefined;

  do {
    if (x) await pollSleep();
    x = await batchScrapeStatus(bss.body.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
  } while (x.body.status === "scraping");

  expectBatchScrapeToSucceed(x);
  return {
    ...x.body,
    id: bss.body.id,
  };
}

// =========================================
// Map API
// =========================================

export async function map(body: MapRequestInput, identity: Identity) {
  return await request(TEST_API_URL)
    .post("/v1/map")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

export function expectMapToSucceed(response: Awaited<ReturnType<typeof map>>) {
  if (response.statusCode !== 200) {
    console.warn("Map did not succeed", JSON.stringify(response.body, null, 2));
  }

  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(Array.isArray(response.body.links)).toBe(true);
  expect(response.body.links.length).toBeGreaterThan(0);
}

// =========================================
// Extract API
// =========================================

async function extractStart(body: ExtractRequestInput, identity: Identity) {
  return await request(TEST_API_URL)
    .post("/v1/extract")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

async function extractStatus(id: string, identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v1/extract/" + encodeURIComponent(id))
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

function expectExtractStartToSucceed(
  response: Awaited<ReturnType<typeof extractStart>>,
) {
  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(typeof response.body.id).toBe("string");
}

function expectExtractToSucceed(
  response: Awaited<ReturnType<typeof extractStatus>>,
) {
  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(typeof response.body.status).toBe("string");
  expect(response.body.status).toBe("completed");
  expect(response.body).toHaveProperty("data");
}

export async function extract(
  body: ExtractRequestInput,
  identity: Identity,
): Promise<ExtractResponse> {
  const es = await extractStart(body, identity);
  expectExtractStartToSucceed(es);

  let x: Awaited<ReturnType<typeof extractStatus>> | undefined;

  do {
    if (x) await pollSleep();
    x = await extractStatus(es.body.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
  } while (x.body.status === "processing");

  expectExtractToSucceed(x);
  return x.body;
}

// =========================================
// Search API
// =========================================

async function searchRaw(body: SearchRequestInput, identity: Identity) {
  return await request(TEST_API_URL)
    .post("/v1/search")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

function expectSearchToSucceed(
  response: Awaited<ReturnType<typeof searchRaw>>,
) {
  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(typeof response.body.data).toBe("object");
  expect(Array.isArray(response.body.data)).toBe(true);
  expect(response.body.data.length).toBeGreaterThan(0);
}

export async function search(
  body: SearchRequestInput,
  identity: Identity,
): Promise<Document[]> {
  const raw = await searchRaw(body, identity);
  expectSearchToSucceed(raw);
  return raw.body.data;
}

// =========================================
// Billing API
// =========================================

export async function creditUsage(
  identity: Identity,
): Promise<{ remaining_credits: number }> {
  const req = await request(TEST_API_URL)
    .get("/v1/team/credit-usage")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json");

  if (req.status !== 200) {
    throw req.body;
  }

  return req.body.data;
}

export async function tokenUsage(
  identity: Identity,
): Promise<{ remaining_tokens: number }> {
  return (
    await request(TEST_API_URL)
      .get("/v1/team/token-usage")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
  ).body.data;
}

// =========================================
// Concurrency API
// =========================================

async function concurrencyCheck(
  identity: Identity,
): Promise<{ concurrency: number; maxConcurrency: number }> {
  const x = await request(TEST_API_URL)
    .get("/v1/team/queue-status")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json");

  expect(x.statusCode).toBe(200);
  expect(x.body.success).toBe(true);
  return {
    concurrency: x.body.activeJobsInQueue,
    maxConcurrency: x.body.maxConcurrency,
  };
}

export async function crawlWithConcurrencyTracking(
  body: CrawlRequestInput,
  identity: Identity,
): Promise<{
  crawl: Exclude<CrawlStatusResponse, ErrorResponse>;
  concurrencies: number[];
}> {
  const cs = await crawlStart(body, identity);
  expectCrawlStartToSucceed(cs);

  let x: Awaited<ReturnType<typeof crawlStatus>> | undefined;
  let concurrencies: number[] = [];

  do {
    if (x) await pollSleep();
    x = await crawlStatus(cs.body.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
    concurrencies.push((await concurrencyCheck(identity)).concurrency);
  } while (x.body.status === "scraping");

  expectCrawlToSucceed(x);
  return {
    crawl: x.body,
    concurrencies,
  };
}

export async function batchScrapeWithConcurrencyTracking(
  body: BatchScrapeRequestInput,
  identity: Identity,
): Promise<{
  batchScrape: Exclude<CrawlStatusResponse, ErrorResponse>;
  concurrencies: number[];
}> {
  const cs = await batchScrapeStart(body, identity);
  expectBatchScrapeStartToSucceed(cs);

  let x: Awaited<ReturnType<typeof batchScrapeStatus>> | undefined;
  let concurrencies: number[] = [];

  do {
    if (x) await pollSleep();
    x = await batchScrapeStatus(cs.body.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
    concurrencies.push((await concurrencyCheck(identity)).concurrency);
  } while (x.body.status === "scraping");

  expectBatchScrapeToSucceed(x);
  return {
    batchScrape: x.body,
    concurrencies,
  };
}

// =========================================
// ZDR API
// =========================================

export async function zdrcleaner(teamId: string) {
  const res = await request(TEST_API_URL)
    .get(`/admin/${config.BULL_AUTH_KEY}/zdrcleaner`)
    .query({ teamId });

  expect(res.statusCode).toBe(200);
  expect(res.body.ok).toBe(true);
}

// =========================================
// =========================================

async function deepResearchStart(
  body: {
    query?: string;
    maxDepth?: number;
    maxUrls?: number;
    timeLimit?: number;
    analysisPrompt?: string;
    systemPrompt?: string;
    formats?: string[];
    topic?: string;
    jsonOptions?: any;
  },
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v1/deep-research")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

async function deepResearchStatus(id: string, identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v1/deep-research/" + encodeURIComponent(id))
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

function expectDeepResearchStartToSucceed(
  response: Awaited<ReturnType<typeof deepResearchStart>>,
) {
  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(typeof response.body.id).toBe("string");
}

export async function deepResearch(
  body: {
    query?: string;
    maxDepth?: number;
    maxUrls?: number;
    timeLimit?: number;
    analysisPrompt?: string;
    systemPrompt?: string;
    formats?: string[];
    topic?: string;
    jsonOptions?: any;
  },
  identity: Identity,
) {
  const ds = await deepResearchStart(body, identity);
  expectDeepResearchStartToSucceed(ds);

  let x: Awaited<ReturnType<typeof deepResearchStatus>> | undefined;

  do {
    if (x) await pollSleep();
    x = await deepResearchStatus(ds.body.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
  } while (x.body.status === "processing");

  expect(x.body.success).toBe(true);
  expect(x.body.status).toBe("completed");
  return x.body;
}
