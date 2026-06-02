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

const values = jest.fn<(data: any) => Promise<void>>();
const insert = jest.fn(() => ({ values }));
jest.mock("../../db/connection", () => ({
  db: { insert },
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
    jest.clearAllMocks();
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
