/**
 * E2E tests for v2 extract (proxied to v1), translated from Python tests
 */
import Firecrawl from "../../../index";
import { config } from "dotenv";
import { getIdentity, getApiUrl } from "./utils/idmux";
import { testTimeoutMs, waitForJob, withRateLimitRetry } from "./utils/rateLimit";
import { describe, test, expect, beforeAll } from "@jest/globals";
import { z } from "zod";

config();

const API_URL = getApiUrl();
let client: Firecrawl;

beforeAll(async () => {
  const { apiKey } = await getIdentity({ name: "js-e2e-extract" });
  client = withRateLimitRetry(new Firecrawl({ apiKey, apiUrl: API_URL }));
});

describe("v2.extract e2e", () => {
  /**
   * Starts an extract, then polls it. Mirrors client.extract, but keeps every
   * request retryable: the wrapper cannot run client.extract again, because a
   * second run would start a second job.
   *
   * The bound is 180s, the time an extract needs, and the same bound batch
   * uses.
   *
   * The bound is not the whole cost of the test. startExtract goes through
   * the wrapper too, so it can spend the retry budget before the poll starts:
   * 150s for the start, plus 180 + 2 + 150 = 332s for the poll, so 482s. Each
   * test below therefore carries a 333_000 ms base, which gives 483s. The
   * unit test "every wrapped call in a test fits its budget" holds that sum.
   */
  async function extractAndWait(
    args: Parameters<typeof client.startExtract>[0],
  ) {
    const started = await client.startExtract(args);
    if (!started.id) return started;
    return waitForJob(() => client.getExtractStatus(started.id!), {
      timeout: 180,
    });
  }

  test("extract minimal with prompt", async () => {
    const resp = await extractAndWait({ urls: ["https://docs.firecrawl.dev"], prompt: "Extract the main page title" });
    expect(typeof resp.success === "boolean" || resp.success == null).toBe(true);
  }, testTimeoutMs(333_000));

  test("extract with schema", async () => {
    const schema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    } as const;
    const resp = await extractAndWait({
      urls: ["https://docs.firecrawl.dev"],
      schema,
      prompt: "Extract the main page title",
      showSources: true,
      enableWebSearch: false,
    });
    expect(typeof resp.success === "boolean" || resp.success == null).toBe(true);
    if ((resp as any).sources != null) {
      expect(typeof (resp as any).sources).toBe("object");
    }
    if (resp.data != null) {
      expect(typeof resp.data).toBe("object");
      expect((resp.data as any).title).toBeTruthy();
    }
  }, testTimeoutMs(333_000));

  test("extract with zod schema", async () => {
    const schema = z.object({
      title: z.string(),
    });
    const resp = await extractAndWait({
      urls: ["https://docs.firecrawl.dev"],
      schema: schema,
      prompt: "Extract the main page title",
      showSources: true,
      enableWebSearch: false,
    });
    expect(typeof resp.success === "boolean" || resp.success == null).toBe(true);
    if ((resp as any).sources != null) {
      expect(typeof (resp as any).sources).toBe("object");
    }
    if (resp.data != null) {
      expect(typeof resp.data).toBe("object");
      expect(schema.safeParse(resp.data).success).toBe(true);
    }
  }, testTimeoutMs(333_000));
});

