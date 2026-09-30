/**
 * E2E tests for v2 usage endpoints (translated from Python tests)
 */
import Firecrawl from "../../../index";
import { config } from "dotenv";
import { getIdentity, getApiUrl } from "./utils/idmux";
import { testTimeoutMs, withRateLimitRetry } from "./utils/rateLimit";
import { describe, test, expect, beforeAll } from "@jest/globals";

config();

const API_URL = getApiUrl();
let client: Firecrawl;

beforeAll(async () => {
  const { apiKey } = await getIdentity({ name: "js-e2e-usage" });
  client = withRateLimitRetry(new Firecrawl({ apiKey, apiUrl: API_URL }));
});

describe("v2.usage e2e", () => {
  test("get_concurrency", async () => {
    const resp = await client.getConcurrency();
    expect(typeof resp.concurrency).toBe("number");
    expect(typeof resp.maxConcurrency).toBe("number");
  }, testTimeoutMs(60_000));

  test("get_credit_usage", async () => {
    const resp = await client.getCreditUsage();
    expect(typeof resp.remainingCredits).toBe("number");
  }, testTimeoutMs(60_000));

  test("get_token_usage", async () => {
    const resp = await client.getTokenUsage();
    expect(typeof resp.remainingTokens).toBe("number");
  }, testTimeoutMs(60_000));

  test("get_queue_status", async () => {
    const resp = await client.getQueueStatus();
    expect(typeof resp.jobsInQueue).toBe("number");
    expect(typeof resp.activeJobsInQueue).toBe("number");
    expect(typeof resp.waitingJobsInQueue).toBe("number");
    expect(typeof resp.maxConcurrency).toBe("number");
  }, testTimeoutMs(60_000));
});

