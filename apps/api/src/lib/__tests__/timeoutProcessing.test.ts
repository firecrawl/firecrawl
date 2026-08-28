import {
  composeTimeoutProcessing,
  getTimeoutProcessingDetails,
  ScrapeJobTimeoutError,
  TransportableError,
} from "../error";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "../error-serde";

const T0 = 1_756_200_000_000;

describe("composeTimeoutProcessing", () => {
  it("estimates from pages minus elapsed, rounded up to whole minutes", () => {
    // 700 pages × 1.25s + 60s base = 935s total; 2min elapsed → 815s
    // remaining → rounds up to 14 minutes; Retry-After caps at 10min.
    const { message, details } = composeTimeoutProcessing({
      pagesEstimate: 700,
      submittedAtMs: T0,
      jobDeadlineAtMs: T0 + 20 * 60_000,
      lastStatus: "running",
      nowMs: T0 + 2 * 60_000,
    });
    expect(details).toEqual({
      state: "processing_continues",
      documentPages: 700,
      jobStatus: "running",
      estimatedRemainingSeconds: 840,
      retryAfterSeconds: 600,
    });
    expect(message).toContain("700-page PDF is still being processed");
    expect(message).toContain("~14 minutes");
  });

  it("queued and published statuses read as queued, place is kept", () => {
    for (const lastStatus of ["queued", "published"] as const) {
      const { message, details } = composeTimeoutProcessing({
        pagesEstimate: 120,
        submittedAtMs: T0,
        lastStatus,
        nowMs: T0,
      });
      expect(details.jobStatus).toBe("queued");
      expect(message).toContain("queued for processing");
      expect(message).toContain("will not lose its place");
    }
  });

  it("estimate floors at one minute and caps Retry-After at 10 minutes", () => {
    // Nearly done: elapsed exceeds the estimate → 1 minute floor.
    const nearlyDone = composeTimeoutProcessing({
      pagesEstimate: 100,
      submittedAtMs: T0,
      lastStatus: "running",
      nowMs: T0 + 30 * 60_000,
    });
    expect(nearlyDone.details.estimatedRemainingSeconds).toBe(60);
    expect(nearlyDone.details.retryAfterSeconds).toBe(60);

    // Monster document: estimate is huge but Retry-After stays sane.
    const monster = composeTimeoutProcessing({
      pagesEstimate: 6_000,
      submittedAtMs: T0,
      lastStatus: "running",
      nowMs: T0,
    });
    expect(monster.details.estimatedRemainingSeconds).toBe(7_560);
    expect(monster.details.retryAfterSeconds).toBe(600);
  });

  it("flags documents that may exceed the job's processing window", () => {
    // 6000 pages ≈ 126min of work against a 30-minute job deadline.
    const { message, details } = composeTimeoutProcessing({
      pagesEstimate: 6_000,
      submittedAtMs: T0,
      jobDeadlineAtMs: T0 + 30 * 60_000,
      lastStatus: "running",
      nowMs: T0,
    });
    expect(details.mayExceedProcessingWindow).toBe(true);
    expect(message).toContain(
      "may exceed the maximum server-side processing window",
    );
    expect(message).toContain("contact support");
  });

  it("handles an unknown page count with a flat conservative estimate", () => {
    const { message, details } = composeTimeoutProcessing({
      submittedAtMs: T0,
      lastStatus: "running",
      nowMs: T0,
    });
    expect(details.documentPages).toBeUndefined();
    expect(details.estimatedRemainingSeconds).toBe(300);
    expect(message).toContain("this PDF");
  });
});

describe("composeTimeoutProcessing — server estimate preference", () => {
  it("prefers fire-pdf's live estimate, aged since observation", () => {
    // Server said 9.5 minutes remaining, observed 90s ago → 8 minutes
    // after aging and minute-ceiling; the static formula (700 pages)
    // would have said 14 minutes here.
    const { message, details } = composeTimeoutProcessing({
      pagesEstimate: 700,
      submittedAtMs: T0,
      lastStatus: "running",
      nowMs: T0 + 2 * 60_000,
      serverEstimate: { remainingMs: 9.5 * 60_000, observedAtMs: T0 + 30_000 },
    });
    expect(details.estimatedRemainingSeconds).toBe(8 * 60);
    expect(message).toContain("~8 minutes");
  });

  it("an aged-out server estimate floors at one minute", () => {
    const { details } = composeTimeoutProcessing({
      pagesEstimate: 700,
      submittedAtMs: T0,
      lastStatus: "running",
      nowMs: T0 + 20 * 60_000,
      serverEstimate: { remainingMs: 60_000, observedAtMs: T0 },
    });
    expect(details.estimatedRemainingSeconds).toBe(60);
  });

  it("falls back to static math when no server estimate was observed", () => {
    const withServer = composeTimeoutProcessing({
      pagesEstimate: 700,
      submittedAtMs: T0,
      lastStatus: "running",
      nowMs: T0 + 2 * 60_000,
    });
    // 700×1.25s + 60s − 2min elapsed → 14 minutes (static path).
    expect(withServer.details.estimatedRemainingSeconds).toBe(840);
  });
});

describe("SCRAPE_TIMEOUT processing details transport", () => {
  it("survives the worker→controller serde round trip", () => {
    const { message, details } = composeTimeoutProcessing({
      pagesEstimate: 700,
      submittedAtMs: T0,
      lastStatus: "running",
      nowMs: T0 + 60_000,
    });
    const original = new ScrapeJobTimeoutError(message, details);
    const revived = deserializeTransportableError(
      serializeTransportableError(original),
    );
    expect(revived).toBeInstanceOf(ScrapeJobTimeoutError);
    expect(revived.message).toBe(message);
    expect(getTimeoutProcessingDetails(revived)).toEqual(details);
  });

  it("getTimeoutProcessingDetails ignores plain timeouts and other errors", () => {
    expect(
      getTimeoutProcessingDetails(new ScrapeJobTimeoutError()),
    ).toBeUndefined();
    expect(
      getTimeoutProcessingDetails(
        new TransportableError("UNKNOWN_ERROR", "nope"),
      ),
    ).toBeUndefined();
    expect(getTimeoutProcessingDetails(new Error("nope"))).toBeUndefined();
  });
});
