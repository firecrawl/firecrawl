import { vi } from "vitest";

// vi.mock is hoisted; anything its factories reference must be created in
// vi.hoisted() (also hoisted). Under Jest these worked because importing `jest`
// from @jest/globals disables jest.mock hoisting.
const {
  logger,
  values,
  insert,
  topic,
  publishes,
  publishMessage,
  flush,
  close,
  metricInc,
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
    logger,
    values,
    insert,
    topic,
    publishes,
    publishMessage,
    flush,
    close,
    metricInc: vi.fn(),
  };
});

vi.mock("@google-cloud/pubsub", () => ({
  PubSub: class {
    topic = topic;
    close = close;
  },
}));

vi.mock("../../config", () => ({
  config: {
    GCS_BUCKET_NAME: undefined,
    PUBSUB_CREDENTIALS: Buffer.from(
      JSON.stringify({ project_id: "firecrawl" }),
    ).toString("base64"),
    USE_DB_AUTHENTICATION: true,
    PUBSUB_MAX_OUTSTANDING_MESSAGES: 10_000,
    PUBSUB_MAX_OUTSTANDING_BYTES: 64 * 1024 * 1024,
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

vi.mock("../../lib/pubsub-log-metrics", () => ({
  pubsubLogPublishTotal: { inc: metricInc },
}));

import {
  logRequest,
  logSearch,
  shutdownPubSubLogging,
  type LoggedSearch,
} from "./log_job";
import * as schema from "../../db/schema";
import { config } from "../../config";

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
    expect(publishes[0].name).toBe("requests");
    const gaxOpts = publishes[0].options.gaxOpts;
    // A bare `timeout` would collapse the retry budget to one attempt.
    expect(gaxOpts.timeout).toBeUndefined();
    expect(gaxOpts.retry.backoffSettings).toMatchObject({
      initialRpcTimeoutMillis: 15_000,
      maxRpcTimeoutMillis: 15_000,
      totalTimeoutMillis: 300_000,
    });
    expect(gaxOpts.retry.retryCodes).toBeUndefined();

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

  it("drops publishes beyond the outstanding cap instead of queueing them", async () => {
    // A fresh module instance: the outstanding counters are process-wide and
    // an earlier test leaves a publish that never settles.
    vi.resetModules();
    const fresh = await import("./log_job.js");
    // Hung channel: publishes never settle, so each one stays outstanding.
    publishMessage.mockReturnValue(new Promise(() => {}));
    config.PUBSUB_MAX_OUTSTANDING_MESSAGES = 2;
    try {
      await fresh.logRequest(makeRequest(null));
      await fresh.logRequest(makeRequest(null));
      await fresh.logRequest(makeRequest(null));
    } finally {
      config.PUBSUB_MAX_OUTSTANDING_MESSAGES = 10_000;
    }

    // The database write is never held back by the publisher.
    expect(values).toHaveBeenCalledTimes(3);
    expect(publishMessage).toHaveBeenCalledTimes(2);
    expect(metricInc).toHaveBeenCalledWith({
      table: "requests",
      outcome: "dropped",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Dropping Pub/Sub log: publisher backlog is full",
      expect.objectContaining({ outstandingMessages: 2, droppedTotal: 1 }),
    );
  });

  it("counts a published row and a failed row separately", async () => {
    await logRequest(makeRequest(null));
    await new Promise(resolve => setImmediate(resolve));
    expect(metricInc).toHaveBeenCalledWith({
      table: "requests",
      outcome: "published",
    });

    publishMessage.mockRejectedValueOnce(new Error("Pub/Sub unavailable"));
    await logRequest(makeRequest(null));
    await new Promise(resolve => setImmediate(resolve));
    expect(metricInc).toHaveBeenCalledWith({
      table: "requests",
      outcome: "failed",
    });
  });

  it("flushes Pub/Sub messages during shutdown", async () => {
    await logRequest(makeRequest(null));

    await Promise.all([shutdownPubSubLogging(), shutdownPubSubLogging()]);

    expect(flush).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("shutdownPubSubLogging deadline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    values.mockResolvedValue(undefined);
    publishMessage.mockResolvedValue("message-id");
    publishes.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the client when a flush outlives the shutdown deadline", async () => {
    // A fresh module instance: shutdown is memoized per process.
    vi.resetModules();
    const fresh = await import("./log_job.js");
    await fresh.logRequest({
      id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
      kind: "scrape",
      api_version: "v2",
      team_id: "team-id",
      origin: "api",
      target_hint: "https://example.com",
      zeroDataRetention: false,
      api_key_id: null,
      external_request_id: null,
    });

    vi.useFakeTimers();
    flush.mockReturnValueOnce(new Promise(() => {}));
    const shutdown = fresh.shutdownPubSubLogging();
    await vi.advanceTimersByTimeAsync(40_000);
    await shutdown;

    expect(close).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "Pub/Sub log flush did not finish before the shutdown deadline; closing anyway",
      expect.objectContaining({ timeoutMs: 40_000 }),
    );
  });
});
