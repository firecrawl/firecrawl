import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: { ttl: vi.fn() },
}));
import { config } from "../config";
import { logger } from "./logger";
import {
  KEYLESS_CONVERSION_COHORT_VERSION,
  keylessConversionCohort,
  keylessExhaustionTelemetry,
  keylessLimitBody,
  keylessTeamId,
  keylessTeamPseudonym,
} from "./keyless";
import { redisRateLimitClient } from "../services/rate-limiter";

describe("keyless conversion cohort telemetry", () => {
  const originalSecret = config.KEYLESS_CONVERSION_HMAC_SECRET;

  afterEach(() => {
    config.KEYLESS_CONVERSION_HMAC_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  it("derives a stable HMAC team pseudonym", () => {
    config.KEYLESS_CONVERSION_HMAC_SECRET = "a".repeat(32);

    const pseudonym = keylessTeamPseudonym(keylessTeamId("203.0.113.8"));

    expect(pseudonym).toBe("preview_keyless_hmac_v1_bcd8d32706120436adde0e52");
    expect(pseudonym).not.toContain("203.0.113.8");
    expect(keylessTeamPseudonym(keylessTeamId("::ffff:203.0.113.8"))).toBe(
      pseudonym,
    );
  });

  it("uses a non-identifying fallback when the HMAC secret is unset", () => {
    config.KEYLESS_CONVERSION_HMAC_SECRET = undefined;

    expect(keylessTeamPseudonym(keylessTeamId("203.0.113.8"))).toBe(
      "preview_keyless_hmac_v1_unconfigured",
    );
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
