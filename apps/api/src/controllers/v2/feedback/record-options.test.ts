import { config } from "../../../config";
import { SEARCH_CREDITS_FEATURE_ID } from "../../../services/autumn/autumn.service";
import { endpointFeedbackSchema, searchFeedbackSchema } from "../types";
import {
  endpointFeedbackRecordOptions,
  searchFeedbackRecordOptions,
} from "./record-options";

const originalConfig = {
  SEARCH_FEEDBACK_MAX_AGE_SEC: config.SEARCH_FEEDBACK_MAX_AGE_SEC,
  SEARCH_FEEDBACK_DAILY_CAP_CREDITS: config.SEARCH_FEEDBACK_DAILY_CAP_CREDITS,
  FEEDBACK_MAX_AGE_SEC: config.FEEDBACK_MAX_AGE_SEC,
  FEEDBACK_DAILY_CAP_CREDITS: config.FEEDBACK_DAILY_CAP_CREDITS,
};

afterEach(() => {
  Object.assign(config, originalConfig);
});

describe("feedback record options", () => {
  it("applies the search feedback policy to legacy search feedback", () => {
    config.SEARCH_FEEDBACK_MAX_AGE_SEC = 17;
    config.SEARCH_FEEDBACK_DAILY_CAP_CREDITS = 3;
    config.FEEDBACK_MAX_AGE_SEC = 999;
    config.FEEDBACK_DAILY_CAP_CREDITS = 999;

    const options = searchFeedbackRecordOptions({
      jobId: "01933161-0000-7000-8000-000000000001",
      feedback: { rating: "bad", note: "Bad search result" },
    });

    expect(options.endpoint).toBe("search");
    expect(options.requireSuccessfulJob).toBe(true);
    expect(options.notFoundCode).toBe("SEARCH_NOT_FOUND");
    expect(options.failedJobCode).toBe("SEARCH_FAILED");
    expect(options.maxAgeSec).toBe(17);
    expect(options.dailyCapCredits).toBe(3);
    expect(options.refundFeatureId).toBe(SEARCH_CREDITS_FEATURE_ID);
    expect(options.source).toBe("search_feedback");
  });

  it("applies the search feedback policy to generic search feedback", () => {
    config.SEARCH_FEEDBACK_MAX_AGE_SEC = 29;
    config.SEARCH_FEEDBACK_DAILY_CAP_CREDITS = 7;
    config.FEEDBACK_MAX_AGE_SEC = 999;
    config.FEEDBACK_DAILY_CAP_CREDITS = 999;

    const options = endpointFeedbackRecordOptions({
      endpoint: "search",
      jobId: "01933161-0000-7000-8000-000000000001",
      feedback: { rating: "bad", note: "Bad search result" },
    });

    expect(options.endpoint).toBe("search");
    expect(options.requireSuccessfulJob).toBe(true);
    expect(options.notFoundCode).toBe("SEARCH_NOT_FOUND");
    expect(options.failedJobCode).toBe("SEARCH_FAILED");
    expect(options.maxAgeSec).toBe(29);
    expect(options.dailyCapCredits).toBe(7);
    expect(options.refundFeatureId).toBe(SEARCH_CREDITS_FEATURE_ID);
    expect(options.source).toBe("search_feedback");
  });

  it("keeps generic non-search feedback on the generic policy", () => {
    const options = endpointFeedbackRecordOptions({
      endpoint: "map",
      jobId: "01933161-0000-7000-8000-000000000001",
      feedback: { rating: "bad", note: "Bad map result" },
    });

    expect(options.endpoint).toBe("map");
    expect(options.requireSuccessfulJob).toBeUndefined();
    expect(options.notFoundCode).toBeUndefined();
    expect(options.failedJobCode).toBeUndefined();
    expect(options.maxAgeSec).toBeUndefined();
    expect(options.dailyCapCredits).toBeUndefined();
    expect(options.refundFeatureId).toBeUndefined();
    expect(options.source).toBe("feedback");
  });
});

describe("feedback schema", () => {
  it("keeps generic search feedback on the search-specific rating rules", () => {
    expect(
      searchFeedbackSchema.safeParse({
        rating: "good",
        valuableSources: [{ url: "https://firecrawl.dev/" }],
      }).success,
    ).toBe(true);

    expect(
      endpointFeedbackSchema.safeParse({
        endpoint: "search",
        jobId: "01933161-0000-7000-8000-000000000001",
        rating: "good",
        valuableSources: [{ url: "https://firecrawl.dev/" }],
      }).success,
    ).toBe(true);

    expect(
      endpointFeedbackSchema.safeParse({
        endpoint: "search",
        jobId: "01933161-0000-7000-8000-000000000001",
        rating: "good",
        note: "A note alone should not satisfy search feedback rules.",
      }).success,
    ).toBe(false);

    expect(
      endpointFeedbackSchema.safeParse({
        endpoint: "map",
        jobId: "01933161-0000-7000-8000-000000000001",
        rating: "good",
        note: "Generic endpoint feedback remains valid with a note.",
      }).success,
    ).toBe(true);
  });
});
