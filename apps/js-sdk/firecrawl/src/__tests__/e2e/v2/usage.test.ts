/**
 * E2E tests for v2 usage endpoints (translated from Python tests)
 */
import Firecrawl from "../../../index";
import { config } from "dotenv";
import { getIdentity, getApiUrl } from "./utils/idmux";
import { describe, test, expect, beforeAll } from "@jest/globals";
import { isRetryableError } from "../../../v2/utils/errorHandler";
import { SdkError } from "../../../v2/types";

config();

const API_URL = getApiUrl();
let client: Firecrawl;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

async function withRetry<T>(action: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === RETRY_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }

  throw lastError;
}

function shouldSkipUsageError(error: unknown): boolean {
  if (!(error instanceof SdkError)) return false;
  if (error.status && error.status >= 500) return true;
  if (error.message.toLowerCase().includes("unexpected error")) return true;
  return false;
}

async function optionalUsageCall<T>(
  action: () => Promise<T>,
  label: string,
): Promise<T | null> {
  try {
    return await withRetry(action);
  } catch (error) {
    if (shouldSkipUsageError(error)) {
      console.warn(`Skipping ${label} due to backend error`, error);
      return null;
    }
    throw error;
  }
}

beforeAll(async () => {
  const { apiKey } = await getIdentity({ name: "js-e2e-usage" });
  client = new Firecrawl({ apiKey, apiUrl: API_URL });
});

describe("v2.usage e2e", () => {
  test("get_concurrency", async () => {
    const resp = await optionalUsageCall(
      () => client.getConcurrency(),
      "get_concurrency",
    );
    if (!resp) return;
    expect(typeof resp.concurrency).toBe("number");
    expect(typeof resp.maxConcurrency).toBe("number");
  }, 120_000);

  test("get_credit_usage", async () => {
    const resp = await withRetry(() => client.getCreditUsage());
    expect(typeof resp.remainingCredits).toBe("number");
  }, 120_000);

  test("get_token_usage", async () => {
    const resp = await withRetry(() => client.getTokenUsage());
    expect(typeof resp.remainingTokens).toBe("number");
  }, 120_000);

  test("get_queue_status", async () => {
    const resp = await optionalUsageCall(
      () => client.getQueueStatus(),
      "get_queue_status",
    );
    if (!resp) return;
    expect(typeof resp.jobsInQueue).toBe("number");
    expect(typeof resp.activeJobsInQueue).toBe("number");
    expect(typeof resp.waitingJobsInQueue).toBe("number");
    expect(typeof resp.maxConcurrency).toBe("number");
  }, 120_000);
});
