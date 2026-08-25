import { config } from "../../../../../config";
import {
  decideFirePdfAsyncRoute,
  deterministicPercentage,
  FIRE_PDF_ASYNC_MIN_REMAINING_MS,
} from "../fire-pdf/routing";
import {
  computeDeadlineMs,
  firePdfHeaders,
  nextPollDelay,
} from "../fire-pdf/utils";

const baseInput = {
  scrapeId: "scrape-1",
  teamId: "team-1",
  zeroDataRetention: false,
  remainingMs: 60_000,
  requestOptIn: false,
  percentage: 0,
  allowRequestOverride: false,
};

describe("FirePDF async routing", () => {
  it("is traffic-neutral by default", () => {
    expect(decideFirePdfAsyncRoute(baseInput)).toEqual({
      enabled: false,
      reason: "percentage_disabled",
    });
  });

  it("never routes ZDR or short-deadline work", () => {
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        zeroDataRetention: true,
        forceTeamIds: "team-1",
      }),
    ).toEqual({ enabled: false, reason: "zdr" });
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        remainingMs: FIRE_PDF_ASYNC_MIN_REMAINING_MS - 1,
        forceTeamIds: "team-1",
      }),
    ).toEqual({ enabled: false, reason: "deadline_too_close" });
  });

  it("lets a denylist override a forced team", () => {
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        forceTeamIds: "team-1",
        disableTeamIds: "team-1",
      }),
    ).toEqual({ enabled: false, reason: "team_disabled" });
  });

  it("supports team canaries and a separately gated request override", () => {
    expect(
      decideFirePdfAsyncRoute({ ...baseInput, forceTeamIds: " team-1 " }),
    ).toEqual({ enabled: true, reason: "team_forced" });
    expect(
      decideFirePdfAsyncRoute({ ...baseInput, requestOptIn: true }),
    ).toEqual({ enabled: false, reason: "percentage_disabled" });
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        requestOptIn: true,
        allowRequestOverride: true,
      }),
    ).toEqual({ enabled: true, reason: "request_override" });
  });

  it("uses a stable request-level percentage cohort", () => {
    expect(deterministicPercentage("same-id")).toBe(
      deterministicPercentage("same-id"),
    );
    expect(decideFirePdfAsyncRoute({ ...baseInput, percentage: 100 })).toEqual({
      enabled: true,
      reason: "percentage",
    });
  });

  it("routes crawl/batch children on their own cohort", () => {
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        bulkOrigin: true,
        bulkOriginPercentage: 100,
      }),
    ).toEqual({ enabled: true, reason: "bulk_origin" });
    // Traffic-neutral by default, like every other cohort.
    expect(decideFirePdfAsyncRoute({ ...baseInput, bulkOrigin: true })).toEqual(
      { enabled: false, reason: "percentage_disabled" },
    );
    // Never applies to non-bulk scrapes.
    expect(
      decideFirePdfAsyncRoute({ ...baseInput, bulkOriginPercentage: 100 }),
    ).toEqual({ enabled: false, reason: "percentage_disabled" });
  });

  it("keeps the hard exclusions ahead of the bulk cohort", () => {
    const bulk = {
      ...baseInput,
      bulkOrigin: true,
      bulkOriginPercentage: 100,
    };
    expect(
      decideFirePdfAsyncRoute({ ...bulk, zeroDataRetention: true }),
    ).toEqual({ enabled: false, reason: "zdr" });
    expect(
      decideFirePdfAsyncRoute({
        ...bulk,
        remainingMs: FIRE_PDF_ASYNC_MIN_REMAINING_MS - 1,
      }),
    ).toEqual({ enabled: false, reason: "deadline_too_close" });
    expect(
      decideFirePdfAsyncRoute({ ...bulk, disableTeamIds: "team-1" }),
    ).toEqual({ enabled: false, reason: "team_disabled" });
  });

  it("cohorts bulk and general percentages independently", () => {
    // The bulk cohort hashes a prefixed key, so a scrape's position in
    // one cohort says nothing about its position in the other.
    const scrapeId = "cohort-independence-probe";
    expect(deterministicPercentage(`bulk-origin:${scrapeId}`)).not.toBe(
      deterministicPercentage(scrapeId),
    );
    // A bulk scrape outside its cohort still falls through to the
    // general percentage.
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        bulkOrigin: true,
        bulkOriginPercentage: 0,
        percentage: 100,
      }),
    ).toEqual({ enabled: true, reason: "percentage" });
  });
});

describe("FirePDF async transport helpers", () => {
  it("uses the server hint as a floor while backing off with jitter", () => {
    expect(nextPollDelay(1_000, 4_500, () => 0)).toBe(4_500);
    expect(nextPollDelay(2_000, 1_000, () => 0)).toBe(4_000);
    expect(nextPollDelay(1_000, undefined, () => 0.5)).toBe(2_200);
    expect(nextPollDelay(4_000, undefined, () => 1)).toBe(5_000);
  });

  it("does not inflate a caller deadline", () => {
    expect(computeDeadlineMs(4_000)).toBe(4_000);
  });

  it("adds the shared FirePDF bearer credential when configured", () => {
    const mutableConfig = config as typeof config & {
      FIRE_PDF_API_KEY?: string;
    };
    const original = config.FIRE_PDF_API_KEY;
    try {
      mutableConfig.FIRE_PDF_API_KEY = "shared-secret";
      expect(firePdfHeaders(true)).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer shared-secret",
      });
    } finally {
      mutableConfig.FIRE_PDF_API_KEY = original;
    }
  });
});
