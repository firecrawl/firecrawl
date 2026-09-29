import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: { ttl: vi.fn() },
}));
import { config } from "../config";
import { logger } from "./logger";
import {
  KEYLESS_CONVERSION_COHORT_VERSION,
  KEYLESS_FREE_TIER_LIMIT_MESSAGE,
  KEYLESS_SIGNUP_URL,
  keylessConversionCohort,
  keylessExhaustionTelemetry,
  keylessLimitBody,
  withKeylessPromptDate,
} from "./keyless";
import { redisRateLimitClient } from "../services/rate-limiter";

describe("keyless conversion cohort telemetry", () => {
  const originalSecret = config.KEYLESS_CONVERSION_HMAC_SECRET;

  afterEach(() => {
    config.KEYLESS_CONVERSION_HMAC_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  it("emits a deterministic, versioned HMAC cohort rather than the IP", () => {
    config.KEYLESS_CONVERSION_HMAC_SECRET = "a".repeat(32);

    const cohort = keylessConversionCohort("203.0.113.8");

    expect(cohort).toMatch(
      new RegExp(`^${KEYLESS_CONVERSION_COHORT_VERSION}:`),
    );
    expect(cohort).not.toContain("203.0.113.8");
    expect(keylessConversionCohort("203.0.113.8")).toBe(cohort);
    expect(keylessConversionCohort("203.0.113.9")).not.toBe(cohort);
    expect(keylessConversionCohort("::ffff:203.0.113.8")).toBe(cohort);
    expect(keylessConversionCohort("::FFFF:203.0.113.8")).toBe(cohort);
    expect(keylessExhaustionTelemetry("203.0.113.8")).toEqual({
      conversionCohort: cohort,
    });
  });

  it("does not emit a cohort when the dedicated analytics secret is unset", () => {
    config.KEYLESS_CONVERSION_HMAC_SECRET = undefined;

    expect(keylessConversionCohort("203.0.113.8")).toBeUndefined();
    expect(keylessExhaustionTelemetry("203.0.113.8")).toEqual({});
  });

  it("does not mint a cohort for a blank IP value", () => {
    config.KEYLESS_CONVERSION_HMAC_SECRET = "a".repeat(32);

    expect(keylessConversionCohort("   ")).toBeUndefined();
    expect(keylessExhaustionTelemetry("   ")).toEqual({});
  });

  it("adds the cohort to reservation-limit exhaustion telemetry", async () => {
    config.KEYLESS_CONVERSION_HMAC_SECRET = "b".repeat(32);
    vi.spyOn(redisRateLimitClient, "ttl").mockResolvedValue(42);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    await keylessLimitBody("preview_keyless_203.0.113.8", "search");

    expect(warn).toHaveBeenCalledWith(
      "Keyless request blocked",
      expect.objectContaining({
        event: "keyless_exhausted",
        reason: "credits",
        conversionCohort: keylessConversionCohort("203.0.113.8"),
      }),
    );
  });
});

describe("keyless signup prompt date", () => {
  const now = new Date("2026-09-30T02:00:00Z");
  const dated = `${KEYLESS_SIGNUP_URL}&utm_content=2026-09-30`;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stamps the keyless signup link with the UTC date of the prompt", () => {
    expect(withKeylessPromptDate(KEYLESS_FREE_TIER_LIMIT_MESSAGE, now)).toBe(
      KEYLESS_FREE_TIER_LIMIT_MESSAGE.replace(KEYLESS_SIGNUP_URL, dated),
    );
  });

  it("leaves stamped messages and messages without the link unchanged", () => {
    const stamped = withKeylessPromptDate(KEYLESS_FREE_TIER_LIMIT_MESSAGE, now);
    expect(
      withKeylessPromptDate(stamped, new Date("2026-10-05T00:00:00Z")),
    ).toBe(stamped);
    expect(withKeylessPromptDate("Browser operation failed.", now)).toBe(
      "Browser operation failed.",
    );
  });

  it("stamps the reservation-limit body", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.spyOn(redisRateLimitClient, "ttl").mockResolvedValue(42);
    vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const body = await keylessLimitBody(
      "preview_keyless_203.0.113.8",
      "search",
    );

    expect(body.error).toContain(dated);
  });
});
