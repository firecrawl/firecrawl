import {
  ExtractRequestInput,
  ExtractResponse,
} from "../../../controllers/v1/types";
import request from "supertest";
import { TEST_API_URL, describeIf, Identity, idmux } from "../lib";
import { sunsetOf } from "../../../lib/deprecations";

// Re-export shared utilities for backwards compatibility
export { Identity, idmux };

// From the extract sunset /v1/extract answers 410 instead of extracting.
export const EXTRACT_SUNSET = sunsetOf("v1_extract");
export const EXTRACT_LIVE = Date.now() < EXTRACT_SUNSET;
export const describeExtract = (cond = true) =>
  describeIf(EXTRACT_LIVE && cond);

// Deep research and llms.txt answer 410 from their own sunsets.
export const DEEP_RESEARCH_LIVE = Date.now() < sunsetOf("v1_deep_research");
export const LLMSTXT_LIVE = Date.now() < sunsetOf("v1_llmstxt");

const pollSleep = async () => new Promise(r => setTimeout(r, 50));

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
