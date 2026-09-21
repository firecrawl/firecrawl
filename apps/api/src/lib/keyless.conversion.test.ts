import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: { ttl: vi.fn() },
}));
import { config } from "../config";
import { logger } from "./logger";
import {
  KEYLESS_CONVERSION_COHORT_VERSION,
  KEYLESS_FREE_TIER_LIMIT_MESSAGE,
  keylessConversionCohort,
  keylessExhaustionTelemetry,
  keylessLimitBody,
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

  it("points quota recovery at API keys without asking for chat credential sharing", () => {
    expect(KEYLESS_FREE_TIER_LIMIT_MESSAGE).toContain(
      "https://www.firecrawl.dev/app/api-keys",
    );
    expect(KEYLESS_FREE_TIER_LIMIT_MESSAGE).not.toContain(
      "https://www.firecrawl.dev/signin",
    );
    expect(KEYLESS_FREE_TIER_LIMIT_MESSAGE).not.toContain(
      "Authorization: Bearer YOUR_API_KEY",
    );
    expect(KEYLESS_FREE_TIER_LIMIT_MESSAGE).toContain(
      "Authorization: Bearer header",
    );
    expect(KEYLESS_FREE_TIER_LIMIT_MESSAGE).toContain(
      "Do not share the API key in chat",
    );
    expect(KEYLESS_FREE_TIER_LIMIT_MESSAGE).toContain("put it in a URL");
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
