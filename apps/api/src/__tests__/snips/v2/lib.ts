import { config } from "../../../config";
import type {
  ScrapeRequestInput as CoreScrapeRequestInput,
  Document,
  CrawlRequestInput as CoreCrawlRequestInput,
  CrawlResponse,
  CrawlStatusResponse,
  OngoingCrawlsResponse,
  ErrorResponse,
  CrawlErrorsResponse,
  MapDocument,
  MapRequestInput as CoreMapRequestInput,
  BatchScrapeRequestInput as CoreBatchScrapeRequestInput,
  SearchRequestInput as CoreSearchRequestInput,
  ParseRequestInput as CoreParseRequestInput,
} from "../../../controllers/v2/types";
import { isJsonObject } from "../../../lib/json-types";
import type { JsonObject, JsonValue } from "../../../lib/json-types";

type ScrapeRequestInput = Omit<CoreScrapeRequestInput, "proxy"> & {
  proxy?: string;
} & JsonObject;
type CrawlRequestInput = Omit<CoreCrawlRequestInput, "scrapeOptions"> & {
  scrapeOptions?: JsonObject;
} & JsonObject;
type MapRequestInput = CoreMapRequestInput & JsonObject;
type BatchScrapeRequestInput = Omit<CoreBatchScrapeRequestInput, "proxy"> & {
  proxy?: string;
} & JsonObject;
type SearchRequestInput = Omit<
  CoreSearchRequestInput,
  "sources" | "categories"
> & {
  sources?: JsonValue;
  categories?: JsonValue;
} & JsonObject;
type ParseRequestOptions = Omit<CoreParseRequestInput, "file" | "proxy"> & {
  proxy?: string;
} & JsonObject;
import request from "supertest";
import {
  TEST_API_URL,
  scrapeTimeout,
  indexCooldown,
  Identity,
  idmux,
} from "../lib";
import type { SearchV2Response } from "../../../lib/entities";

// Re-export shared utilities for backwards compatibility
export { scrapeTimeout, indexCooldown, Identity, idmux, TEST_API_URL };
export default request;

const pollSleep = async () =>
  new Promise<void>(r => {
    setTimeout(r, 50);
  });

type FailureResponseBody = {
  success: false;
  error: string;
  code?: string;
  details?: JsonValue;
};

type OngoingCrawlsSuccess = Exclude<OngoingCrawlsResponse, ErrorResponse>;
type CrawlStartSuccess = Exclude<CrawlResponse, ErrorResponse>;
type CrawlStatusBody = Exclude<CrawlStatusResponse, ErrorResponse>;
type CrawlErrorsBody = Exclude<CrawlErrorsResponse, ErrorResponse>;

type FeedbackSuccessResponse = JsonObject & {
  success: true;
  feedbackId: string;
  creditsRefunded: number;
  creditsRefundedToday?: number;
  dailyRefundCap?: number;
  dailyCapReached?: boolean;
  alreadySubmitted?: boolean;
  warning?: string;
};

type CreditUsageHistoricalResponse = {
  success: boolean;
  periods: Array<{
    startDate: string | null;
    endDate: string | null;
    apiKey?: string;
    creditsUsed: number;
  }>;
};

type TokenUsageHistoricalResponse = {
  success: boolean;
  periods: Array<{
    startDate: string | null;
    endDate: string | null;
    tokensUsed: number;
  }>;
};

function isDocument(value: unknown): value is Document {
  return isJsonObject(value);
}

function isFailureResponseBody(value: unknown): value is FailureResponseBody {
  return (
    isJsonObject(value) &&
    value.success === false &&
    typeof value.error === "string" &&
    (value.code === undefined || typeof value.code === "string")
  );
}

function isOngoingCrawlsSuccess(value: unknown): value is OngoingCrawlsSuccess {
  return (
    isJsonObject(value) && value.success === true && Array.isArray(value.crawls)
  );
}

function isCrawlStartSuccess(value: unknown): value is CrawlStartSuccess {
  return (
    isJsonObject(value) &&
    value.success === true &&
    typeof value.id === "string"
  );
}

function isCrawlStatusBody(value: unknown): value is CrawlStatusBody {
  return isJsonObject(value) && typeof value.status === "string";
}

function isCrawlErrorsBody(value: unknown): value is CrawlErrorsBody {
  return (
    isJsonObject(value) &&
    Array.isArray(value.errors) &&
    Array.isArray(value.robotsBlocked)
  );
}

function isMapDocument(value: unknown): value is MapDocument {
  return isJsonObject(value) && typeof value.url === "string";
}

function isSearchV2Response(value: unknown): value is SearchV2Response {
  return isJsonObject(value);
}

function isFeedbackSuccessResponse(
  value: unknown,
): value is FeedbackSuccessResponse {
  return (
    isJsonObject(value) &&
    value.success === true &&
    typeof value.feedbackId === "string" &&
    typeof value.creditsRefunded === "number"
  );
}

function isCreditUsageData(
  value: unknown,
): value is { remainingCredits: number } {
  return isJsonObject(value) && typeof value.remainingCredits === "number";
}

function isCreditUsageHistoricalResponse(
  value: unknown,
): value is CreditUsageHistoricalResponse {
  return (
    isJsonObject(value) &&
    typeof value.success === "boolean" &&
    Array.isArray(value.periods)
  );
}

function isTokenUsageHistoricalResponse(
  value: unknown,
): value is TokenUsageHistoricalResponse {
  return (
    isJsonObject(value) &&
    typeof value.success === "boolean" &&
    Array.isArray(value.periods)
  );
}

// =========================================
// Scrape API
// =========================================

export async function scrapeRaw(
  body: ScrapeRequestInput | JsonObject,
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v2/scrape")
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
  const bodyValue: unknown = raw.body;
  if (!isJsonObject(bodyValue) || !isDocument(bodyValue.data)) {
    throw new Error("Unexpected scrape response shape");
  }
  return bodyValue.data;
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
  const bodyValue: unknown = raw.body;
  if (!isFailureResponseBody(bodyValue)) {
    throw new Error("Unexpected scrape failure response shape");
  }
  return bodyValue;
}

// =========================================
// Monitor API
// =========================================

export type MonitorCreateInput = {
  name: string;
  schedule: { cron: string; timezone?: string };
  webhook?: { url: string; headers?: Record<string, string> };
  notification?: {
    email?: {
      enabled?: boolean;
      recipients?: Array<string>;
      includeDiffs?: boolean;
    };
  };
  targets: Array<
    | {
        type: "scrape";
        urls: Array<string>;
        scrapeOptions?: JsonObject;
      }
    | {
        type: "crawl";
        url: string;
        crawlOptions?: JsonObject;
        scrapeOptions?: JsonObject;
      }
    | {
        type: "search";
        queries: Array<string>;
      }
  >;
  retentionDays?: number;
  goal?: string;
  judgeEnabled?: boolean;
  origin?: string;
};

export async function monitorCreateRaw(
  body: MonitorCreateInput | JsonObject,
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v2/monitor")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

export async function monitorListRaw(identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v2/monitor")
    .set("Authorization", `Bearer ${identity.apiKey}`);
}

export async function monitorGetRaw(id: string, identity: Identity) {
  return await request(TEST_API_URL)
    .get(`/v2/monitor/${id}`)
    .set("Authorization", `Bearer ${identity.apiKey}`);
}

export async function monitorPatchRaw(
  id: string,
  body: Partial<MonitorCreateInput> & { status?: "active" | "paused" },
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .patch(`/v2/monitor/${id}`)
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

export async function monitorDeleteRaw(id: string, identity: Identity) {
  return await request(TEST_API_URL)
    .delete(`/v2/monitor/${id}`)
    .set("Authorization", `Bearer ${identity.apiKey}`);
}

export async function monitorRunRaw(id: string, identity: Identity) {
  return await request(TEST_API_URL)
    .post(`/v2/monitor/${id}/run`)
    .set("Authorization", `Bearer ${identity.apiKey}`);
}

export async function monitorCheckRaw(
  monitorId: string,
  checkId: string,
  identity: Identity,
  query?: Record<string, string | number>,
) {
  const req = request(TEST_API_URL)
    .get(`/v2/monitor/${monitorId}/checks/${checkId}`)
    .set("Authorization", `Bearer ${identity.apiKey}`);
  return query ? req.query(query) : req;
}

export async function monitorEmailConfirmRaw(token: string) {
  return await request(TEST_API_URL)
    .post(`/v2/monitor/email/confirm`)
    .set("Content-Type", "application/json")
    .send({ token });
}

export async function monitorEmailUnsubscribeRaw(token: string) {
  return await request(TEST_API_URL)
    .post(`/v2/monitor/email/unsubscribe`)
    .set("Content-Type", "application/json")
    .send({ token });
}

export async function monitorEmailConfirmRawViaQuery(token: string) {
  return await request(TEST_API_URL)
    .post(`/v2/monitor/email/confirm`)
    .query({ token });
}

export async function parseRaw(
  body: {
    options?: ParseRequestOptions;
    file: {
      content: Buffer | string;
      filename: string;
      contentType?: string;
    };
  },
  identity: Identity,
) {
  const fileContent =
    typeof body.file.content === "string"
      ? Buffer.from(body.file.content)
      : body.file.content;

  const req = request(TEST_API_URL)
    .post("/v2/parse")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .attach("file", fileContent, {
      filename: body.file.filename,
      contentType: body.file.contentType,
    });

  if (body.options !== undefined) {
    req.field("options", JSON.stringify(body.options));
  }

  return await req;
}

export async function parse(
  body: {
    options?: ParseRequestOptions;
    file: {
      content: Buffer | string;
      filename: string;
      contentType?: string;
    };
  },
  identity: Identity,
): Promise<Document> {
  const raw = await parseRaw(body, identity);
  expectScrapeToSucceed(raw);
  const bodyValue: unknown = raw.body;
  if (!isJsonObject(bodyValue) || !isDocument(bodyValue.data)) {
    throw new Error("Unexpected parse response shape");
  }
  return bodyValue.data;
}

export async function parseWithFailure(
  body: {
    options?: ParseRequestOptions | JsonObject;
    file?: {
      content: Buffer | string;
      filename: string;
      contentType?: string;
    };
    rawOptions?: string;
  },
  identity: Identity,
): Promise<{
  success: false;
  error: string;
  code?: string;
}> {
  const req = request(TEST_API_URL)
    .post("/v2/parse")
    .set("Authorization", `Bearer ${identity.apiKey}`);

  if (body.file) {
    const fileContent =
      typeof body.file.content === "string"
        ? Buffer.from(body.file.content)
        : body.file.content;

    req.attach("file", fileContent, {
      filename: body.file.filename,
      contentType: body.file.contentType,
    });
  }

  if (body.rawOptions !== undefined) {
    req.field("options", body.rawOptions);
  } else if (body.options !== undefined) {
    req.field("options", JSON.stringify(body.options));
  }

  const raw = await req;
  expect(raw.statusCode).not.toBe(200);
  expect(raw.body.success).toBe(false);
  expect(typeof raw.body.error).toBe("string");
  const bodyValue: unknown = raw.body;
  if (!isFailureResponseBody(bodyValue)) {
    throw new Error("Unexpected parse failure response shape");
  }
  return bodyValue;
}

export async function scrapeStatusRaw(jobId: string, identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v2/scrape/" + encodeURIComponent(jobId))
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
  const bodyValue: unknown = raw.body;
  if (!isJsonObject(bodyValue) || !isDocument(bodyValue.data)) {
    throw new Error("Unexpected scrape status response shape");
  }
  return bodyValue.data;
}

export async function scrapeInteractRaw(
  jobId: string,
  body: {
    code: string;
    language?: "python" | "node" | "bash";
    timeout?: number;
    origin?: string;
  },
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v2/scrape/" + encodeURIComponent(jobId) + "/interact")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

export async function scrapeStopInteractiveBrowserRaw(
  jobId: string,
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .delete("/v2/scrape/" + encodeURIComponent(jobId) + "/interact")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

// =========================================
// Interact (standalone browser sessions)
// =========================================

export async function browserCreateRaw(
  body: {
    ttl?: number;
    activityTtl?: number;
    recordSession?: boolean;
    streamWebView?: boolean;
    profile?: { name: string; saveChanges?: boolean };
    location?: JsonObject;
  },
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v2/interact")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

export async function browserExecuteRaw(
  sessionId: string,
  body: {
    code: string;
    language?: "python" | "node" | "bash";
    timeout?: number;
  },
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v2/interact/" + encodeURIComponent(sessionId) + "/execute")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

export async function browserDeleteRaw(sessionId: string, identity: Identity) {
  return await request(TEST_API_URL)
    .delete("/v2/interact/" + encodeURIComponent(sessionId))
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

export async function browserReplayRaw(sessionId: string, identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v2/interact/" + encodeURIComponent(sessionId) + "/replay")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

export async function browserReplayPageRaw(
  sessionId: string,
  pageId: string,
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .get(
      `/v2/interact/${encodeURIComponent(sessionId)}/replay/${encodeURIComponent(pageId)}`,
    )
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

// =========================================
// Crawl API
// =========================================

export async function crawlStart(body: CrawlRequestInput, identity: Identity) {
  return await request(TEST_API_URL)
    .post("/v2/crawl")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

async function crawlStatus(id: string, identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v2/crawl/" + encodeURIComponent(id))
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

async function crawlOngoingRaw(identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v2/crawl/ongoing")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

export async function crawlOngoing(
  identity: Identity,
): Promise<Exclude<OngoingCrawlsResponse, ErrorResponse>> {
  const res = await crawlOngoingRaw(identity);
  expect(res.statusCode).toBe(200);
  expect(res.body.success).toBe(true);
  const bodyValue: unknown = res.body;
  if (!isOngoingCrawlsSuccess(bodyValue)) {
    throw new Error("Unexpected ongoing crawls response shape");
  }
  return bodyValue;
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
  const bodyValue: unknown = cs.body;
  if (!isCrawlStartSuccess(bodyValue)) {
    throw new Error("Unexpected crawl start response shape");
  }
  return bodyValue;
}

export async function asyncCrawlWaitForFinish(
  id: string,
  identity: Identity,
): Promise<Exclude<CrawlStatusResponse, ErrorResponse>> {
  let x: Awaited<ReturnType<typeof crawlStatus>> | undefined;

  do {
    if (x) {
      await pollSleep();
    }
    x = await crawlStatus(id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
  } while (x.body.status === "scraping");

  expectCrawlToSucceed(x);
  const bodyValue: unknown = x.body;
  if (!isCrawlStatusBody(bodyValue)) {
    throw new Error("Unexpected crawl status response shape");
  }
  return bodyValue;
}

export async function crawlErrors(
  id: string,
  identity: Identity,
): Promise<Exclude<CrawlErrorsResponse, ErrorResponse>> {
  const res = await request(TEST_API_URL)
    .get("/v2/crawl/" + id + "/errors")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();

  expect(res.statusCode).toBe(200);
  expect(res.body.success).not.toBe(false);

  const bodyValue: unknown = res.body;
  if (!isCrawlErrorsBody(bodyValue)) {
    throw new Error("Unexpected crawl errors response shape");
  }
  return bodyValue;
}

export async function crawl(
  body: CrawlRequestInput,
  identity: Identity,
  shouldSucceed: boolean = true,
): Promise<Exclude<CrawlStatusResponse & { id: string }, ErrorResponse>> {
  const cs = await crawlStart(body, identity);
  expectCrawlStartToSucceed(cs);
  const startBody: unknown = cs.body;
  if (!isCrawlStartSuccess(startBody)) {
    throw new Error("Unexpected crawl start response shape");
  }

  let x: Awaited<ReturnType<typeof crawlStatus>> | undefined;

  do {
    if (x) {
      await pollSleep();
    }
    x = await crawlStatus(startBody.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
  } while (x.body.status === "scraping");

  const errors = await crawlErrors(startBody.id, identity);
  if (errors.errors.length > 0) {
    console.warn("Crawl ", startBody.id, " had errors:", errors.errors);
  }

  if (shouldSucceed) {
    expectCrawlToSucceed(x);
  }

  const statusBody: unknown = x.body;
  if (!isCrawlStatusBody(statusBody)) {
    throw new Error("Unexpected crawl status response shape");
  }

  return {
    ...statusBody,
    id: startBody.id,
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
    .post("/v2/batch/scrape")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

async function batchScrapeStatus(id: string, identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v2/batch/scrape/" + encodeURIComponent(id))
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
  const startBody: unknown = bss.body;
  if (!isCrawlStartSuccess(startBody)) {
    throw new Error("Unexpected batch scrape start response shape");
  }

  let x: Awaited<ReturnType<typeof batchScrapeStatus>> | undefined;

  do {
    if (x) {
      await pollSleep();
    }
    x = await batchScrapeStatus(startBody.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
  } while (x.body.status === "scraping");

  expectBatchScrapeToSucceed(x);
  const statusBody: unknown = x.body;
  if (!isCrawlStatusBody(statusBody)) {
    throw new Error("Unexpected batch scrape status response shape");
  }
  return {
    ...statusBody,
    id: startBody.id,
  };
}

// =========================================
// Map API
// =========================================

export async function map(body: MapRequestInput, identity: Identity) {
  return await request(TEST_API_URL)
    .post("/v2/map")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

export function getMapLinks(
  response: Awaited<ReturnType<typeof map>>,
): Array<MapDocument> {
  const bodyValue: unknown = response.body;
  if (
    !isJsonObject(bodyValue) ||
    !Array.isArray(bodyValue.links) ||
    !bodyValue.links.every(isMapDocument)
  ) {
    throw new Error("Unexpected map response links shape");
  }
  return [...bodyValue.links];
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
// Search API
// =========================================

export async function searchRaw(
  body: SearchRequestInput | JsonObject,
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v2/search")
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
}

function expectSearchToFail(response: Awaited<ReturnType<typeof searchRaw>>) {
  expect(response.statusCode).not.toBe(200);
  expect(response.body.success).toBe(false);
  expect(typeof response.body.error).toBe("string");
}

export async function search(
  body: SearchRequestInput,
  identity: Identity,
): Promise<SearchV2Response> {
  const raw = await searchRaw(body, identity);
  expectSearchToSucceed(raw);
  const bodyValue: unknown = raw.body;
  if (!isJsonObject(bodyValue) || !isSearchV2Response(bodyValue.data)) {
    throw new Error("Unexpected search response shape");
  }
  return bodyValue.data;
}

export async function searchWithFailure(
  body: SearchRequestInput | JsonObject,
  identity: Identity,
): Promise<{
  success: false;
  error: string;
  details?: unknown;
}> {
  const raw = await searchRaw(body, identity);
  expectSearchToFail(raw);
  const bodyValue: unknown = raw.body;
  if (!isFailureResponseBody(bodyValue)) {
    throw new Error("Unexpected search failure response shape");
  }
  return bodyValue;
}

export async function researchRaw(
  path: string,
  query: Record<string, string | number | boolean | Array<string>> | undefined,
  identity?: Identity,
  headers?: Record<string, string>,
) {
  const req = request(TEST_API_URL)
    .get(path)
    .set("Content-Type", "application/json");
  if (identity) {
    req.set("Authorization", `Bearer ${identity.apiKey}`);
  }
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      req.set(key, value);
    }
  }
  return query ? req.query(query) : req;
}

export async function researchPostRaw(
  path: string,
  body: JsonObject,
  identity?: Identity,
) {
  const req = request(TEST_API_URL)
    .post(path)
    .set("Content-Type", "application/json");
  if (identity) {
    req.set("Authorization", `Bearer ${identity.apiKey}`);
  }
  return req.send(body);
}

export async function searchRawFull(
  body: SearchRequestInput,
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v2/search")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

export async function searchFeedbackRaw(
  searchId: string,
  body: JsonObject,
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v2/search/" + encodeURIComponent(searchId) + "/feedback")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

export async function searchFeedback(
  searchId: string,
  body: JsonObject,
  identity: Identity,
): Promise<{
  success: true;
  feedbackId: string;
  creditsRefunded: number;
  creditsRefundedToday?: number;
  dailyRefundCap?: number;
  dailyCapReached?: boolean;
  alreadySubmitted?: boolean;
  warning?: string;
}> {
  const raw = await searchFeedbackRaw(searchId, body, identity);
  if (raw.statusCode !== 200) {
    console.warn(
      "Search feedback did not succeed",
      JSON.stringify(raw.body, null, 2),
    );
  }
  expect(raw.statusCode).toBe(200);
  expect(raw.body.success).toBe(true);
  expect(typeof raw.body.feedbackId).toBe("string");
  expect(typeof raw.body.creditsRefunded).toBe("number");
  const bodyValue: unknown = raw.body;
  if (!isFeedbackSuccessResponse(bodyValue)) {
    throw new Error("Unexpected search feedback response shape");
  }
  return bodyValue;
}

export async function searchFeedbackWithFailure(
  searchId: string,
  body: JsonObject,
  identity: Identity,
): Promise<{
  success: false;
  error: string;
  details?: unknown;
}> {
  const raw = await searchFeedbackRaw(searchId, body, identity);
  expect(raw.statusCode).not.toBe(200);
  expect(raw.body.success).toBe(false);
  expect(typeof raw.body.error).toBe("string");
  const bodyValue: unknown = raw.body;
  if (!isFailureResponseBody(bodyValue)) {
    throw new Error("Unexpected search feedback failure response shape");
  }
  return bodyValue;
}

// =========================================
// Generic Feedback API
// =========================================

export async function endpointFeedbackRaw(
  body: JsonObject,
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v2/feedback")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

export async function endpointFeedback(
  body: JsonObject,
  identity: Identity,
): Promise<FeedbackSuccessResponse> {
  const raw = await endpointFeedbackRaw(body, identity);
  if (raw.statusCode !== 200) {
    console.warn(
      "Endpoint feedback did not succeed",
      JSON.stringify(raw.body, null, 2),
    );
  }
  expect(raw.statusCode).toBe(200);
  expect(raw.body.success).toBe(true);
  expect(typeof raw.body.feedbackId).toBe("string");
  expect(typeof raw.body.creditsRefunded).toBe("number");
  const bodyValue: unknown = raw.body;
  if (!isFeedbackSuccessResponse(bodyValue)) {
    throw new Error("Unexpected endpoint feedback response shape");
  }
  return bodyValue;
}

export async function endpointFeedbackWithFailure(
  body: JsonObject,
  identity: Identity,
): Promise<{
  success: false;
  error: string;
  details?: unknown;
}> {
  const raw = await endpointFeedbackRaw(body, identity);
  expect(raw.statusCode).not.toBe(200);
  expect(raw.body.success).toBe(false);
  expect(typeof raw.body.error).toBe("string");
  const bodyValue: unknown = raw.body;
  if (!isFailureResponseBody(bodyValue)) {
    throw new Error("Unexpected endpoint feedback failure response shape");
  }
  return bodyValue;
}

// =========================================
// Billing API
// =========================================

export async function creditUsage(
  identity: Identity,
): Promise<{ remainingCredits: number }> {
  const req = await request(TEST_API_URL)
    .get("/v2/team/credit-usage")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json");

  if (req.status !== 200) {
    throw req.body;
  }

  const bodyValue: unknown = req.body;
  if (!isJsonObject(bodyValue) || !isCreditUsageData(bodyValue.data)) {
    throw new Error("Unexpected credit-usage response shape");
  }
  return bodyValue.data;
}

export async function creditUsageHistorical(
  identity: Identity,
  options: { byApiKey?: boolean } = {},
): Promise<CreditUsageHistoricalResponse> {
  const req = await request(TEST_API_URL)
    .get("/v2/team/credit-usage/historical")
    .query(options.byApiKey ? { byApiKey: "true" } : {})
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json");

  if (req.status !== 200) {
    throw req.body;
  }

  const bodyValue: unknown = req.body;
  if (!isCreditUsageHistoricalResponse(bodyValue)) {
    throw new Error("Unexpected historical credit-usage response shape");
  }
  return bodyValue;
}

export async function tokenUsageHistorical(
  identity: Identity,
): Promise<TokenUsageHistoricalResponse> {
  const req = await request(TEST_API_URL)
    .get("/v2/team/token-usage/historical")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json");

  if (req.status !== 200) {
    throw req.body;
  }

  const bodyValue: unknown = req.body;
  if (!isTokenUsageHistoricalResponse(bodyValue)) {
    throw new Error("Unexpected historical token-usage response shape");
  }
  return bodyValue;
}

// =========================================
// Concurrency API
// =========================================

async function concurrencyCheck(
  identity: Identity,
): Promise<{ concurrency: number; maxConcurrency: number }> {
  const x = await request(TEST_API_URL)
    .get("/v2/team/queue-status")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json");

  expect(x.statusCode).toBe(200);
  expect(x.body.success).toBe(true);
  const bodyValue: unknown = x.body;
  if (
    !isJsonObject(bodyValue) ||
    typeof bodyValue.activeJobsInQueue !== "number" ||
    typeof bodyValue.maxConcurrency !== "number"
  ) {
    throw new Error("Unexpected queue-status response shape");
  }
  return {
    concurrency: bodyValue.activeJobsInQueue,
    maxConcurrency: bodyValue.maxConcurrency,
  };
}

export async function crawlWithConcurrencyTracking(
  body: CrawlRequestInput,
  identity: Identity,
): Promise<{
  crawl: Exclude<CrawlStatusResponse, ErrorResponse>;
  concurrencies: Array<number>;
}> {
  const cs = await crawlStart(body, identity);
  expectCrawlStartToSucceed(cs);
  const startBody: unknown = cs.body;
  if (!isCrawlStartSuccess(startBody)) {
    throw new Error("Unexpected crawl start response shape");
  }

  let x: Awaited<ReturnType<typeof crawlStatus>> | undefined;
  const concurrencies: Array<number> = [];

  do {
    if (x) {
      await pollSleep();
    }
    x = await crawlStatus(startBody.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
    concurrencies.push((await concurrencyCheck(identity)).concurrency);
  } while (x.body.status === "scraping");

  expectCrawlToSucceed(x);
  const statusBody: unknown = x.body;
  if (!isCrawlStatusBody(statusBody)) {
    throw new Error("Unexpected crawl status response shape");
  }
  return {
    crawl: statusBody,
    concurrencies,
  };
}

export async function batchScrapeWithConcurrencyTracking(
  body: BatchScrapeRequestInput,
  identity: Identity,
): Promise<{
  batchScrape: Exclude<CrawlStatusResponse, ErrorResponse>;
  concurrencies: Array<number>;
}> {
  const cs = await batchScrapeStart(body, identity);
  expectBatchScrapeStartToSucceed(cs);
  const startBody: unknown = cs.body;
  if (!isCrawlStartSuccess(startBody)) {
    throw new Error("Unexpected batch scrape start response shape");
  }

  let x: Awaited<ReturnType<typeof batchScrapeStatus>> | undefined;
  const concurrencies: Array<number> = [];

  do {
    if (x) {
      await pollSleep();
    }
    x = await batchScrapeStatus(startBody.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
    concurrencies.push((await concurrencyCheck(identity)).concurrency);
  } while (x.body.status === "scraping");

  expectBatchScrapeToSucceed(x);
  const statusBody: unknown = x.body;
  if (!isCrawlStatusBody(statusBody)) {
    throw new Error("Unexpected batch scrape status response shape");
  }
  return {
    batchScrape: statusBody,
    concurrencies,
  };
}

// =========================================
// ZDR API
// =========================================

export async function zdrcleaner(teamId: string) {
  const res = await request(TEST_API_URL)
    .get("/admin/ops/zdrcleaner")
    .set("Authorization", `Bearer ${config.BULL_AUTH_KEY}`)
    .query({ teamId });

  expect(res.statusCode).toBe(200);
  expect(res.body.ok).toBe(true);
}
