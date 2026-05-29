import { jest } from "@jest/globals";

const captureException = jest.fn();
jest.mock("@sentry/node", () => ({
  captureException,
}));

jest.mock("../../config", () => ({
  config: {
    GCS_BUCKET_NAME: undefined,
    USE_DB_AUTHENTICATION: true,
  },
}));

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => logger),
};
jest.mock("../../lib/logger", () => ({
  logger,
}));

const insert = jest.fn<(data: any) => Promise<{ error: any }>>();
const from = jest.fn(() => ({
  insert,
}));
jest.mock("../supabase", () => ({
  supabase_service: {
    from,
  },
}));

jest.mock("../../lib/gcs-jobs", () => ({
  saveDeepResearchToGCS: jest.fn(),
  saveExtractToGCS: jest.fn(),
  saveLlmsTxtToGCS: jest.fn(),
  saveMapToGCS: jest.fn(),
  saveScrapeToGCS: jest.fn(),
  saveSearchToGCS: jest.fn(),
}));

jest.mock("../../lib/extract/extract-redis", () => ({
  saveExtractResult: jest.fn(),
}));

import { logSearch, type LoggedSearch } from "./log_job";

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
    jest.clearAllMocks();
    insert.mockResolvedValue({ error: null });
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

    expect(from).toHaveBeenCalledWith("searches");
    const inserted = insert.mock.calls[0][0];
    expect(inserted.query).toBe("helloworld");
    expect(inserted.options.query).toBe("nestedquery");
    expect(inserted.options.sources[0].location).toBe("New\u0000York");
    expect(search.options.query).toBe("nested\u0000query");
  });

  it("uses sanitized data in Sentry insert failure context", async () => {
    insert.mockResolvedValueOnce({
      error: {
        code: "22P05",
        message: "unsupported Unicode escape sequence",
      },
    });

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
