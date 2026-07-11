import { RateLimiterRes } from "rate-limiter-flexible";
import { isRateLimiterRes, buildRateLimitMessage } from "./rate-limit-error";

/**
 * Regression tests for issue #3728.
 *
 * The auth controller's rate-limit `catch` block used to assume every
 * rejection from `rateLimiter.consume()` was a `RateLimiterRes` and read
 * `.msBeforeNext` / `.consumedPoints` / `.remainingPoints` off it. When the
 * rate-limit Redis store is unreachable — and with no `insuranceLimiter`
 * configured (see `services/rate-limiter.ts`) — `consume()` rejects with a
 * plain `Error` instead. That produced a bogus HTTP 429 with `undefined`
 * fields on *every* authenticated request while the store was down.
 *
 * The fix discriminates the rejection: genuine `RateLimiterRes` -> 429 with
 * populated fields (unchanged); store/infra `Error` -> fail open.
 */
describe("rate-limit-error discrimination (#3728)", () => {
  it("treats a genuine RateLimiterRes as a real rate-limit hit", () => {
    // RateLimiterRes(remainingPoints, msBeforeNext, consumedPoints, isFirstInDuration)
    const res = new RateLimiterRes(0, 30000, 100, false);

    expect(isRateLimiterRes(res)).toBe(true);

    const { secs, message } = buildRateLimitMessage(res);
    expect(secs).toBe(30);
    // Populated, not "undefined", fields in the user-facing message.
    expect(message).toContain("Consumed (req/min): 100");
    expect(message).toContain("Remaining (req/min): 0");
    expect(message).not.toContain("undefined");
  });

  it("does NOT treat a backing-store Error as a rate-limit hit (fail open)", () => {
    // What `consume()` rejects with when rate-limit Redis is unreachable and
    // no insuranceLimiter is configured.
    const storeError = new Error("Connection is closed.");

    // The fail-open assertion: an infra error must not be classified as a
    // genuine rate-limit rejection, so the caller will NOT return a 429.
    expect(isRateLimiterRes(storeError)).toBe(false);
  });

  it("does NOT treat undefined/null rejections as a rate-limit hit", () => {
    expect(isRateLimiterRes(undefined)).toBe(false);
    expect(isRateLimiterRes(null)).toBe(false);
  });

  it("does NOT treat an object with non-numeric msBeforeNext as a hit", () => {
    expect(isRateLimiterRes({ msBeforeNext: undefined })).toBe(false);
    expect(isRateLimiterRes({ msBeforeNext: "soon" })).toBe(false);
  });
});
