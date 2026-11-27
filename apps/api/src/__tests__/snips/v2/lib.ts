import { z } from "zod";
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
import type { ErrorCode } from "../../../lib/error";
import { jsonObjectSchema, jsonValueSchema } from "../../../lib/json-types";
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

type OngoingCrawlsSuccess = Exclude<OngoingCrawlsResponse, ErrorResponse>;
type CrawlErrorsBody = Exclude<CrawlErrorsResponse, ErrorResponse>;

const documentSchema = z.custom<Document>(
  value => jsonObjectSchema.safeParse(value).success,
);

const documentEnvelopeSchema = z.object({
  data: documentSchema,
});

const failureResponseBodySchema = z.object({
  success: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
  details: jsonValueSchema.optional(),
});

const ongoingCrawlsShapeSchema = z.object({
  success: z.literal(true),
  crawls: z.array(
    z.object({
      id: z.string(),
      teamId: z.string(),
      url: z.string(),
      created_at: z.string(),
      options: jsonObjectSchema,
    }),
  ),
});

const ongoingCrawlsSuccessSchema = z.custom<OngoingCrawlsSuccess>(
  value => ongoingCrawlsShapeSchema.safeParse(value).success,
);

const crawlStartSuccessSchema = z.object({
  success: z.literal(true),
  id: z.string(),
  url: z.string(),
});

const crawlStatusBodySchema = z.object({
  success: z.literal(true),
  status: z.enum(["scraping", "completed", "failed", "cancelled"]),
  completed: z.number(),
  total: z.number(),
  creditsUsed: z.number(),
  expiresAt: z.string(),
  createdAt: z.string().optional(),
  completedAt: z.string().optional(),
  duration: z.number().optional(),
  next: z.string().optional(),
  data: z.array(documentSchema),
  warning: z.string().optional(),
});

const crawlStatusFailedBodySchema = z.object({
  success: z.literal(false),
  status: z.literal("failed"),
  error: z.string(),
  completed: z.number(),
  total: z.number(),
  creditsUsed: z.number(),
  expiresAt: z.string(),
  createdAt: z.string().optional(),
  completedAt: z.string().optional(),
  duration: z.number().optional(),
  next: z.string().optional(),
  data: z.array(documentSchema),
  warning: z.string().optional(),
});

const crawlStatusResponseBodySchema = z.discriminatedUnion("success", [
  crawlStatusBodySchema,
  crawlStatusFailedBodySchema,
]);

const requiresActionShapeSchema = z.object({
  type: z.string(),
  terms: z.string().optional(),
  version: z.string().optional(),
  url: z.string().optional(),
});

const crawlErrorsBodySchema = z.object({
  errors: z.array(
    z.object({
      id: z.string(),
      timestamp: z.string().optional(),
      url: z.string(),
      code: z
        .custom<ErrorCode>(
          value => typeof value === "string" && value.length > 0,
        )
        .optional(),
      error: z.string(),
      requiresAction: z
        .custom<
          NonNullable<CrawlErrorsBody["errors"][number]["requiresAction"]>
        >(
          value =>
            jsonObjectSchema.safeParse(value).success &&
            requiresActionShapeSchema.safeParse(value).success,
        )
        .optional(),
    }),
  ),
  robotsBlocked: z.array(z.string()),
});

const mapDocumentSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

const mapResponseBodySchema = z.object({
  links: z.array(mapDocumentSchema),
});

const searchV2ResponseSchema = z.custom<SearchV2Response>(
  value => jsonObjectSchema.safeParse(value).success,
);

const searchEnvelopeSchema = z.object({
  data: searchV2ResponseSchema,
});

const feedbackSuccessResponseSchema = z.object({
  success: z.literal(true),
  feedbackId: z.string(),
  creditsRefunded: z.number(),
  creditsRefundedToday: z.number().optional(),
  dailyRefundCap: z.number().optional(),
  dailyCapReached: z.boolean().optional(),
  alreadySubmitted: z.boolean().optional(),
  warning: z.string().optional(),
});

type FeedbackSuccessResponse = z.infer<typeof feedbackSuccessResponseSchema>;

const creditUsageEnvelopeSchema = z.object({
  data: z.object({
    remainingCredits: z.number(),
  }),
});

const creditUsageHistoricalResponseSchema = z.object({
  success: z.boolean(),
  periods: z.array(
    z.object({
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      apiKey: z.string().optional(),
      creditsUsed: z.number(),
    }),
  ),
});

type CreditUsageHistoricalResponse = z.infer<
  typeof creditUsageHistoricalResponseSchema
>;

const tokenUsageHistoricalResponseSchema = z.object({
  success: z.boolean(),
  periods: z.array(
    z.object({
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      tokensUsed: z.number(),
    }),
  ),
});

type TokenUsageHistoricalResponse = z.infer<
  typeof tokenUsageHistoricalResponseSchema
>;

const queueStatusResponseSchema = z.object({
  activeJobsInQueue: z.number(),
  maxConcurrency: z.number(),
});

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
  const parsed = documentEnvelopeSchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected scrape response shape");
  }
  return parsed.data.data;
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
  const parsed = failureResponseBodySchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected scrape failure response shape");
  }
  return parsed.data;
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
  const parsed = documentEnvelopeSchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected parse response shape");
  }
  return parsed.data.data;
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
  const parsed = failureResponseBodySchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected parse failure response shape");
  }
  return parsed.data;
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
  const parsed = documentEnvelopeSchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected scrape status response shape");
  }
  return parsed.data.data;
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
  const parsed = ongoingCrawlsSuccessSchema.safeParse(res.body);
  if (!parsed.success) {
    throw new Error("Unexpected ongoing crawls response shape");
  }
  return parsed.data;
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
  const parsed = crawlStartSuccessSchema.safeParse(cs.body);
  if (!parsed.success) {
    throw new Error("Unexpected crawl start response shape");
  }
  return parsed.data;
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
  const parsed = crawlStatusBodySchema.safeParse(x.body);
  if (!parsed.success) {
    throw new Error("Unexpected crawl status response shape");
  }
  return parsed.data;
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

  const parsed = crawlErrorsBodySchema.safeParse(res.body);
  if (!parsed.success) {
    throw new Error("Unexpected crawl errors response shape");
  }
  return parsed.data;
}

export async function crawl(
  body: CrawlRequestInput,
  identity: Identity,
  shouldSucceed: boolean = true,
): Promise<z.infer<typeof crawlStatusResponseBodySchema> & { id: string }> {
  const cs = await crawlStart(body, identity);
  expectCrawlStartToSucceed(cs);
  const parsedStart = crawlStartSuccessSchema.safeParse(cs.body);
  if (!parsedStart.success) {
    throw new Error("Unexpected crawl start response shape");
  }

  let x: Awaited<ReturnType<typeof crawlStatus>> | undefined;

  do {
    if (x) {
      await pollSleep();
    }
    x = await crawlStatus(parsedStart.data.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
  } while (x.body.status === "scraping");

  const errors = await crawlErrors(parsedStart.data.id, identity);
  if (errors.errors.length > 0) {
    console.warn("Crawl ", parsedStart.data.id, " had errors:", errors.errors);
  }

  if (shouldSucceed) {
    expectCrawlToSucceed(x);
  }

  const parsedStatus = (
    shouldSucceed ? crawlStatusBodySchema : crawlStatusResponseBodySchema
  ).safeParse(x.body);
  if (!parsedStatus.success) {
    throw new Error("Unexpected crawl status response shape");
  }

  return {
    ...parsedStatus.data,
    id: parsedStart.data.id,
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
  const parsedStart = crawlStartSuccessSchema.safeParse(bss.body);
  if (!parsedStart.success) {
    throw new Error("Unexpected batch scrape start response shape");
  }

  let x: Awaited<ReturnType<typeof batchScrapeStatus>> | undefined;

  do {
    if (x) {
      await pollSleep();
    }
    x = await batchScrapeStatus(parsedStart.data.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
  } while (x.body.status === "scraping");

  expectBatchScrapeToSucceed(x);
  const parsedStatus = crawlStatusBodySchema.safeParse(x.body);
  if (!parsedStatus.success) {
    throw new Error("Unexpected batch scrape status response shape");
  }
  return {
    ...parsedStatus.data,
    id: parsedStart.data.id,
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
  const parsed = mapResponseBodySchema.safeParse(response.body);
  if (!parsed.success) {
    throw new Error("Unexpected map response links shape");
  }
  return parsed.data.links;
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
  const parsed = searchEnvelopeSchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected search response shape");
  }
  return parsed.data.data;
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
  const parsed = failureResponseBodySchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected search failure response shape");
  }
  return parsed.data;
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
  const parsed = feedbackSuccessResponseSchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected search feedback response shape");
  }
  return parsed.data;
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
  const parsed = failureResponseBodySchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected search feedback failure response shape");
  }
  return parsed.data;
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
  const parsed = feedbackSuccessResponseSchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected endpoint feedback response shape");
  }
  return parsed.data;
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
  const parsed = failureResponseBodySchema.safeParse(raw.body);
  if (!parsed.success) {
    throw new Error("Unexpected endpoint feedback failure response shape");
  }
  return parsed.data;
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

  const parsed = creditUsageEnvelopeSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new Error("Unexpected credit-usage response shape");
  }
  return parsed.data.data;
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

  const parsed = creditUsageHistoricalResponseSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new Error("Unexpected historical credit-usage response shape");
  }
  return parsed.data;
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

  const parsed = tokenUsageHistoricalResponseSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new Error("Unexpected historical token-usage response shape");
  }
  return parsed.data;
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
  const parsed = queueStatusResponseSchema.safeParse(x.body);
  if (!parsed.success) {
    throw new Error("Unexpected queue-status response shape");
  }
  return {
    concurrency: parsed.data.activeJobsInQueue,
    maxConcurrency: parsed.data.maxConcurrency,
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
  const parsedStart = crawlStartSuccessSchema.safeParse(cs.body);
  if (!parsedStart.success) {
    throw new Error("Unexpected crawl start response shape");
  }

  let x: Awaited<ReturnType<typeof crawlStatus>> | undefined;
  const concurrencies: Array<number> = [];

  do {
    if (x) {
      await pollSleep();
    }
    x = await crawlStatus(parsedStart.data.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
    concurrencies.push((await concurrencyCheck(identity)).concurrency);
  } while (x.body.status === "scraping");

  expectCrawlToSucceed(x);
  const parsedStatus = crawlStatusBodySchema.safeParse(x.body);
  if (!parsedStatus.success) {
    throw new Error("Unexpected crawl status response shape");
  }
  return {
    crawl: parsedStatus.data,
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
  const parsedStart = crawlStartSuccessSchema.safeParse(cs.body);
  if (!parsedStart.success) {
    throw new Error("Unexpected batch scrape start response shape");
  }

  let x: Awaited<ReturnType<typeof batchScrapeStatus>> | undefined;
  const concurrencies: Array<number> = [];

  do {
    if (x) {
      await pollSleep();
    }
    x = await batchScrapeStatus(parsedStart.data.id, identity);
    expect(x.statusCode).toBe(200);
    expect(typeof x.body.status).toBe("string");
    concurrencies.push((await concurrencyCheck(identity)).concurrency);
  } while (x.body.status === "scraping");

  expectBatchScrapeToSucceed(x);
  const parsedStatus = crawlStatusBodySchema.safeParse(x.body);
  if (!parsedStatus.success) {
    throw new Error("Unexpected batch scrape status response shape");
  }
  return {
    batchScrape: parsedStatus.data,
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
