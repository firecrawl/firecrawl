import { vi } from "vitest";

// vi.mock is hoisted; anything its factories reference must be created in
// vi.hoisted() (also hoisted). Under Jest these worked because importing `jest`
// from @jest/globals disables jest.mock hoisting.
const {
  captureException,
  logger,
  values,
  insert,
  topic,
  publishes,
  publishMessage,
  flush,
  close,
} = vi.hoisted(() => {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  const values = vi.fn<(data: any) => Promise<void>>();
  const insert = vi.fn(() => ({ values }));
  const publishMessage = vi.fn(async (_message: any) => "message-id");
  const flush = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const publishes: { name: string; options: any }[] = [];
  const topic = vi.fn((name: string, options: any) => {
    return {
      publishMessage: (message: any) => {
        publishes.push({ name, options });
        return publishMessage(message);
      },
      flush,
    };
  });
  return {
    captureException: vi.fn(),
    logger,
    values,
    insert,
    topic,
    publishes,
    publishMessage,
    flush,
    close,
  };
});

vi.mock("@google-cloud/pubsub", () => ({
  PubSub: class {
    topic = topic;
    close = close;
  },
}));

vi.mock("@sentry/node", () => ({
  captureException,
}));

vi.mock("../../config", () => ({
  config: {
    GCS_BUCKET_NAME: undefined,
    PUBSUB_CREDENTIALS: Buffer.from(
      JSON.stringify({ project_id: "firecrawl" }),
    ).toString("base64"),
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
  logRequest,
  logSearch,
  shutdownPubSubLogging,
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

describe("logSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    values.mockResolvedValue(undefined);
    publishMessage.mockResolvedValue("message-id");
    publishes.length = 0;
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
    expect(inserted.options.sources[0].location).toBe("NewYork");
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
    publishMessage.mockResolvedValue("message-id");
    publishes.length = 0;
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

  it("writes the request to the database and its Pub/Sub topic", async () => {
    await logRequest(makeRequest("op_integration_42"));

    expect(insert).toHaveBeenCalledWith(schema.requests);
    expect(publishes).toContainEqual({
      name: "requests",
      options: { gaxOpts: { timeout: 60_000 } },
    });

    const published = JSON.parse(
      publishMessage.mock.calls[0][0].data.toString("utf8"),
    );
    expect(published.id).toBe("019e6f45-7778-727d-adf0-0abe9d5062b6");
    expect(published.external_request_id).toBe("op_integration_42");
    expect(new Date(published.created_at).toISOString()).toBe(
      published.created_at,
    );
    expect(values.mock.calls[0][0].created_at.toISOString()).toBe(
      published.created_at,
    );
  });

  it("keeps the database write when Pub/Sub fails", async () => {
    publishMessage.mockRejectedValueOnce(new Error("Pub/Sub unavailable"));

    await expect(logRequest(makeRequest(null))).resolves.toBeUndefined();

    expect(values).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to publish log to Pub/Sub",
      expect.objectContaining({ error: expect.any(Error) }),
    );
    expect(captureException).toHaveBeenCalled();
  });

  it("does not hold the caller on a slow publish", async () => {
    publishMessage.mockReturnValueOnce(new Promise(() => {}));

    await expect(logRequest(makeRequest(null))).resolves.toBeUndefined();
    expect(values).toHaveBeenCalled();
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

  it("cleans NUL bytes and unpaired surrogates for both stores", async () => {
    // "Łódź" mis-decoded by a client arrives as a lone low surrogate, which
    // JSON.stringify would emit as "\udc81" and ClickPipes would reject as
    // invalid JSON; PostgreSQL's driver stores it as U+FFFD. The row must
    // reach both stores already cleaned, and identical.
    const replacement = String.fromCharCode(0xfffd);
    await logRequest({
      ...makeRequest(null),
      target_hint: "wyciek Å\udc81Ã³dÅº" + String.fromCharCode(0) + "!",
      origin: "api" + String.fromCharCode(0),
    });

    const inserted = values.mock.calls[0][0];
    expect(inserted.target_hint).toBe("wyciek Å" + replacement + "Ã³dÅº!");
    expect(inserted.origin).toBe("api");

    const raw = publishMessage.mock.calls[0][0].data.toString("utf8");
    expect(raw).not.toMatch(/\\u[dD][89a-fA-F]/);
    expect(raw).not.toMatch(/\\u0{4}/);
    const published = JSON.parse(raw);
    expect(published.target_hint).toBe(inserted.target_hint);
    expect(published.origin).toBe("api");
  });

  it("flushes Pub/Sub messages during shutdown", async () => {
    await logRequest(makeRequest(null));

    await Promise.all([shutdownPubSubLogging(), shutdownPubSubLogging()]);

    expect(flush).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
