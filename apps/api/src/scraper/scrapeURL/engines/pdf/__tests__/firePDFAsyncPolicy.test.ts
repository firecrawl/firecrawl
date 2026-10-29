import { FIRE_PDF_ASYNC_MIN_REMAINING_MS } from "../fire-pdf/routing";
import { FIRE_PDF_SUBMIT_503_CODES } from "../fire-pdf/schema";
import { classifyTransient503 } from "../fire-pdf/submit";
import { alignPollDelay, computeInlineJobDeadlineMs } from "../fire-pdf/utils";

// Pure policy for the fire-pdf async client: deadline math, poll scheduling
// around the job deadline, and submit-503 classification. The orchestration
// suite (firePDFAsync.test.ts) covers how these compose on the wire.

describe("computeInlineJobDeadlineMs", () => {
  it("takes a 10% margin off the caller window, floored at 10s and capped at 30s", () => {
    expect(computeInlineJobDeadlineMs(30_000)).toBe(20_000);
    expect(computeInlineJobDeadlineMs(60_000)).toBe(50_000);
    expect(computeInlineJobDeadlineMs(300_000)).toBe(270_000);
    expect(computeInlineJobDeadlineMs(1_800_000)).toBe(1_770_000);
  });

  it("never advertises less than fire-pdf's 5s minimum", () => {
    expect(computeInlineJobDeadlineMs(15_000)).toBe(5_000);
    expect(computeInlineJobDeadlineMs(1_000)).toBe(5_000);
  });

  it("leaves the smallest window the router admits a deadline above the minimum", () => {
    expect(computeInlineJobDeadlineMs(FIRE_PDF_ASYNC_MIN_REMAINING_MS)).toBe(
      10_000,
    );
  });
});

describe("alignPollDelay", () => {
  const now = 100_000;

  it("leaves backoff alone without a job deadline or with one far away", () => {
    expect(alignPollDelay(5_000, now, undefined)).toBe(5_000);
    expect(alignPollDelay(5_000, now, now + 60_000)).toBe(5_000);
  });

  it("pulls the next poll to land just after the job deadline", () => {
    expect(alignPollDelay(5_000, now, now + 2_500)).toBe(3_500);
    expect(alignPollDelay(5_000, now, now + 200)).toBe(1_200);
  });

  it("polls at the floor once the job deadline has passed", () => {
    expect(alignPollDelay(5_000, now, now - 500)).toBe(1_000);
    expect(alignPollDelay(5_000, now, now - 5_000)).toBe(1_000);
  });
});

describe("classifyTransient503", () => {
  it("names the retry trigger for a 503 that never reached fire-pdf's handler", () => {
    expect(
      classifyTransient503(503, {
        error: "Service Unavailable",
        message: "Service Unavailable",
        statusCode: 503,
      }),
    ).toBe("http_503_closing");
    expect(classifyTransient503(503, {})).toBe("http_503_unattributed");
    expect(classifyTransient503(503, null)).toBe("http_503_unattributed");
    // An intermediary's own snake_case code is not a fire-pdf code.
    expect(
      classifyTransient503(503, {
        error: "upstream_unavailable",
        message: "no healthy upstream",
      }),
    ).toBe("http_503_unattributed");
  });

  it("leaves fire-pdf's own 503 codes and other statuses alone", () => {
    for (const code of FIRE_PDF_SUBMIT_503_CODES) {
      expect(classifyTransient503(503, { error: code })).toBe(null);
    }
    expect(
      classifyTransient503(503, {
        error: "admission_unavailable",
        message: "could not safely admit async work",
      }),
    ).toBe(null);
    expect(classifyTransient503(502, {})).toBe(null);
  });
});
