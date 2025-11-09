import { ScrapeRetryTracker } from "../retryTracker";
import { ScrapeRetryLimitError } from "../error";
import type { Logger } from "winston";

describe("ScrapeRetryTracker", () => {
  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger;

  const config = {
    maxAttempts: 5,
    maxFeatureToggles: 3,
    maxFeatureRemovals: 3,
    maxPdfPrefetches: 2,
    maxDocumentPrefetches: 2,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("throws when per-error limits exceeded", () => {
    const tracker = new ScrapeRetryTracker(
      { ...config, maxPdfPrefetches: 1 },
      logger,
    );
    tracker.record("pdf_antibot", new Error("first"));
    expect(() => tracker.record("pdf_antibot", new Error("second"))).toThrow(
      ScrapeRetryLimitError,
    );
  });

  it("throws when global attempts exceeded", () => {
    const tracker = new ScrapeRetryTracker(
      { ...config, maxAttempts: 1 },
      logger,
    );
    tracker.record("feature_toggle", new Error("1"));
    expect(() => tracker.record("document_antibot", new Error("2"))).toThrow(
      ScrapeRetryLimitError,
    );
  });

  it("allows retries within limits", () => {
    const tracker = new ScrapeRetryTracker(config, logger);
    expect(() => {
      tracker.record("feature_toggle", new Error("toggle"));
      tracker.record("feature_removal", new Error("removal"));
      tracker.record("document_antibot", new Error("doc"));
    }).not.toThrow();
  });

  it("tracks feature toggle limits separately", () => {
    const tracker = new ScrapeRetryTracker(
      { ...config, maxFeatureToggles: 1 },
      logger,
    );

    expect(() =>
      tracker.record("feature_toggle", new Error("first")),
    ).not.toThrow();
    expect(() => tracker.record("feature_toggle", new Error("second"))).toThrow(
      ScrapeRetryLimitError,
    );
    expect(logger.error).toHaveBeenCalledWith(
      "scrapeURL retry limit reached",
      expect.objectContaining({ reason: "feature_toggle" }),
    );
  });

  it("enforces mixed global cap", () => {
    const tracker = new ScrapeRetryTracker(
      { ...config, maxAttempts: 3 },
      logger,
    );
    tracker.record("feature_toggle", new Error("1"));
    tracker.record("feature_removal", new Error("2"));
    tracker.record("document_antibot", new Error("3"));
    expect(() => tracker.record("pdf_antibot", new Error("4"))).toThrow(
      ScrapeRetryLimitError,
    );
  });

  it("serializes stats in thrown error", () => {
    const tracker = new ScrapeRetryTracker(
      { ...config, maxDocumentPrefetches: 1 },
      logger,
    );
    tracker.record("document_antibot", new Error("first"));
    expect.assertions(3);
    try {
      tracker.record("document_antibot", new Error("second"));
    } catch (error) {
      expect(error).toBeInstanceOf(ScrapeRetryLimitError);
      if (error instanceof ScrapeRetryLimitError) {
        expect(error.stats.documentAntibotAttempts).toBe(2);
        expect(error.reason).toBe("document_antibot");
      }
    }
  });
});
