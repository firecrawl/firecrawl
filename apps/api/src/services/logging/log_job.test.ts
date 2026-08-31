import { vi } from "vitest";

// vi.mock is hoisted; anything its factories reference must be created in
// vi.hoisted() (also hoisted). Under Jest these worked because importing `jest`
// from @jest/globals disables jest.mock hoisting.
const { captureException, logger, values, insert } = vi.hoisted(() => {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  const values = vi.fn<(data: any) => Promise<void>>();
  const insert = vi.fn(() => ({ values }));
  return { captureException: vi.fn(), logger, values, insert };
});

vi.mock("@sentry/node", () => ({
  captureException,
}));

vi.mock("../../config", () => ({
  config: {
    GCS_BUCKET_NAME: undefined,
    KEYLESS_CONVERSION_HMAC_SECRET: "a".repeat(32),
    USE_DB_AUTHENTICATION: true,
  },
}));

vi.mock("../../lib/logger", () => ({
  logger,
}));

vi.mock("../../db/connection", () => ({
  db: { insert },
}));

vi.mock("../../lib/gcs-jobs", () => ({
  saveDeepResearchToGCS: vi.fn(),
  saveExtractToGCS: vi.fn(),
  saveLlmsTxtToGCS: vi.fn(),
  saveMapToGCS: vi.fn(),
  saveScrapeToGCS: vi.fn(),
  saveSearchToGCS: vi.fn(),
}));

vi.mock("../../lib/extract/extract-redis", () => ({
  saveExtractResult: vi.fn(),
}));

vi.mock("../posthog", () => ({
  trackFirstSurfaceUse: vi.fn(),
}));

import {
  logBatchScrape,
  logCrawl,
  logDeepResearch,
  logExtract,
  logLlmsTxt,
  logMap,
  logRequest,
  logScrape,
  logSearch,
  type LoggedSearch,
} from "./log_job";
import * as schema from "../../db/schema";

function makeSearch(overrides: Partial<LoggedSearch> = {}): LoggedSearch {
  return {
    id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
    request_id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
    query: "hello",
    team_id: "team-id",
    options: {
      query: "hello",
      sources: [{ type: "web", location: "Boston" }],
    },
    time_taken: 100,
    credits_cost: 1,
    is_successful: true,
    num_results: 0,
    results: null,
    zeroDataRetention: false,
    ...overrides,
  };
}

describe("keyless logger identity", () => {
  const teamId = "preview_keyless_203.0.113.8";
  const expected = "preview_keyless_hmac_v1_bcd8d32706120436adde0e52";
  const base = {
    id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
    request_id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
    team_id: teamId,
    zeroDataRetention: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    values.mockResolvedValue(undefined);
  });

  it.each([
    ["scrape", () => logScrape({ ...base, options: {} } as any)],
    ["crawl", () => logCrawl({ ...base, options: {} } as any)],
    ["batch scrape", () => logBatchScrape(base as any)],
    ["extract", () => logExtract(base as any)],
    ["map", () => logMap({ ...base, results: [] } as any)],
    ["llms.txt", () => logLlmsTxt(base as any)],
    ["deep research", () => logDeepResearch(base as any)],
  ])("pseudonymizes %s logger context", async (_name, run) => {
    await run();

    expect(logger.child).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: expected }),
    );
    expect(JSON.stringify(logger.child.mock.calls)).not.toContain(teamId);
  });
});

describe("logSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    values.mockResolvedValue(undefined);
  });

  it("removes null bytes from search query log fields", async () => {
    const search = makeSearch({
      query: "hello\u0000world",
      options: {
        query: "nested\u0000query",
        sources: [{ type: "web", location: "New\u0000York" }],
      },
    });

    await logSearch(search);

    expect(insert).toHaveBeenCalledWith(schema.searches);
    const inserted = values.mock.calls[0][0];
    expect(inserted.query).toBe("helloworld");
    expect(inserted.options.query).toBe("nestedquery");
    expect(inserted.options.sources[0].location).toBe("New\u0000York");
    expect(search.options.query).toBe("nested\u0000query");
  });

  it("uses sanitized data in Sentry insert failure context", async () => {
    values.mockRejectedValueOnce(
      Object.assign(new Error("unsupported Unicode escape sequence"), {
        code: "22P05",
      }),
    );

    await logSearch(
      makeSearch({
        query: "bad\u0000query",
        options: { query: "bad\u0000query" },
      }),
    );

    expect(captureException).toHaveBeenCalled();
    const context = captureException.mock.calls[0][1] as {
      extra: { data: string };
    };
    expect(context.extra.data).not.toContain("\\u0000");
    expect(context.extra.data).toContain("badquery");
  });
});

describe("logRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    values.mockResolvedValue(undefined);
  });

  function makeRequest(externalRequestId: string | null) {
    return {
      id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
      kind: "scrape" as const,
      api_version: "v2",
      team_id: "team-id",
      origin: "api",
      target_hint: "https://example.com",
      zeroDataRetention: false,
      api_key_id: null,
      external_request_id: externalRequestId,
    };
  }

  it("stores the caller's external_request_id verbatim", async () => {
    await logRequest(makeRequest("op_integration_42"));

    expect(insert).toHaveBeenCalledWith(schema.requests);
    expect(values.mock.calls[0][0].external_request_id).toBe(
      "op_integration_42",
    );
  });

  it("stores null, not a truncation, when the id exceeds the byte cap", async () => {
    // The header helper already drops these; this asserts the bound holds at
    // the insert boundary too, for any writer that bypasses the helper. Null
    // rather than a DB constraint, which would fail the whole requests row
    // (and its scrapes/crawls children) over a telemetry field — and null
    // rather than truncation, which would hand a wrong id back downstream.
    await logRequest(makeRequest("x".repeat(2049)));

    const inserted = values.mock.calls[0][0];
    expect(inserted.external_request_id).toBeNull();
    expect(inserted.id).toBe("019e6f45-7778-727d-adf0-0abe9d5062b6");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("counts the cap in bytes, not characters", async () => {
    // 1025 two-byte characters: 1025 chars, 2050 bytes — over.
    await logRequest(makeRequest("é".repeat(1025)));
    expect(values.mock.calls[0][0].external_request_id).toBeNull();

    // 1024 two-byte characters: 2048 bytes exactly — allowed.
    await logRequest(makeRequest("é".repeat(1024)));
    expect(values.mock.calls[1][0].external_request_id).toBe("é".repeat(1024));
  });
});
